// ---------- رسالة تلقائية للطالب اللي سكت أسبوع ----------
//
// **القرار ده كان بشري بالكامل.** الطالب اللي بيعدّي أسبوع من غير رد بيتلوّن بنفسجي في
// القايمة، وخلاص — لو محدش فتح تذكرته وحطّ موعد متابعة بإيده، مفيش حاجة بتوصله مهما طال
// سكوته. اتقاس على الإنتاج: ١٤٨٥ تذكرة ساكتة، ١٥ منها بس عليها موعد.
//
// الوظيفة دي بتاخد نفس القرار تلقائيًا، وبتستخدم **نفس تعريف السكوت** اللي بيلوّن بنفسجي
// (`SILENT_WEEK_SQL`) — عشان اللي الموظف شايفه في القايمة هو بالظبط اللي بيتبعتله.
//
// ---------- قواعد مقصودة ----------
//
// **مرة واحدة لكل فترة سكوت.** الطالب اللي مارضيش يرد على التنبيه الأول، تكراره كل أسبوع
// مش هيقنعه — هيضايقه. الرسالة مابتترجعش إلا لو الطالب كلّمنا تاني وبعدين سكت من جديد،
// وده اللي بيفحصه `silent_follow_up_sent_at` مقابل آخر رسالة واردة منه.
//
// **موظف الواتساب مستثنى.** التذكرة اللي معاه دي محادثة إقناع شغّالة مع طالب مش مشترك،
// ورسالة آلية جاية من جهة تانية في نصّها بتلخبط الطالب.
//
// **في مواعيد معقولة بس.** الوظيفة بتشتغل كل ساعة، لكن الإرسال متقصور على النهار —
// رسالة "طمّنا عليك" الساعة ٤ الفجر بتعمل عكس هدفها.
//
// **سقف لكل تشغيلة.** أول مرة تشتغل هتلاقي أكتر من ألف تذكرة متراكمة. من غير السقف ده
// كانوا هيتبعتوا مرة واحدة — حِمل على تليجرام، وطوفان عند التيم لو ردّوا كلهم في نفس الوقت.

const cron = require('node-cron');
const pool = require('../config/db');
const botManager = require('../bot/botManager');
const { getFirstName } = require('../bot/broadcastSender');
const { studentMenuOptions } = require('../bot/studentMenu');
const { isPermanentSendError } = require('../utils/telegramErrors');
const { SILENT_WEEK_SQL } = require('../utils/silentStudent');

const BATCH_LIMIT = 40;
// بتوقيت القاهرة. البداية متأخرة عن بداية الدوام عن قصد: التيم لازم يكون موجود لما الردود تيجي
const SEND_FROM_HOUR = 11;
const SEND_TO_HOUR = 21;

let running = false;

const CANDIDATES_SQL = `
  SELECT t.id, t.current_idea_number, c.chat_id, c.first_name, c.telegram_username,
         tafra.name AS tafra_name, tafra.gender
  FROM tickets t
  JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN LATERAL (
    SELECT name, gender FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
  ) tafra ON TRUE
  WHERE ${SILENT_WEEK_SQL}
    AND COALESCE(t.transfer_team, '') <> 'whatsapp'
    -- مرة واحدة لكل فترة سكوت: لو اتبعتت قبل كده، مابتترجعش إلا لو الطالب كلّمنا بعدها
    AND (
      t.silent_follow_up_sent_at IS NULL
      OR t.silent_follow_up_sent_at < (
        SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id
      )
    )
  ORDER BY t.last_message_at DESC NULLS LAST
  LIMIT $1`;

async function loadSettings() {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('silent_follow_up_enabled', 'silent_follow_up_message')");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function withinSendingHours(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false,
  }).format(now));
  return hour >= SEND_FROM_HOUR && hour < SEND_TO_HOUR;
}

// نفس استبدال "الاسم" المستخدم في باقي الرسايل الآلية — الطالب بيشوف اسمه الأول بس
function personalize(template, student) {
  return String(template).replaceAll('الاسم', getFirstName(student));
}

// `dryRun` بيرجّع مين كان هياخد الرسالة من غير ما يبعت — بيتستخدم قبل التشغيل الأول
async function runSilentFollowUps({ dryRun = false, limit = BATCH_LIMIT } = {}) {
  const settings = await loadSettings();
  if (!dryRun) {
    if (settings.silent_follow_up_enabled !== 'true') return { skipped: 'مقفولة من اللوحة' };
    if (!settings.silent_follow_up_message) return { skipped: 'مفيش نص رسالة' };
    if (!withinSendingHours()) return { skipped: 'بره مواعيد الإرسال' };
  }

  const { rows } = await pool.query(CANDIDATES_SQL, [limit]);
  if (dryRun) {
    return {
      dry_run: true,
      would_send: rows.length,
      sample: rows.slice(0, 8).map((r) => ({
        ticket_id: r.id,
        name: getFirstName(r),
        preview: settings.silent_follow_up_message
          ? personalize(settings.silent_follow_up_message, r).split('\n')[0]
          : null,
      })),
    };
  }

  const bot = botManager.getBot();
  if (!bot) return { skipped: 'البوت مش متصل' };

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    // **الحجز قبل الإرسال.** لو اتبعتت والتسجيل فشل بعدها، الطالب بياخدها تاني كل ساعة.
    // الحجز الأول بيخلي أسوأ حالة إن الرسالة ماتوصلش، مش إنها تتكرر
    const claimed = await pool.query(
      `UPDATE tickets SET silent_follow_up_sent_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND (
           silent_follow_up_sent_at IS NULL
           OR silent_follow_up_sent_at < (
             SELECT MAX(im.received_at) FROM incoming_messages im
             WHERE im.contact_id = tickets.contact_id
           )
         )
       RETURNING id`,
      [row.id]);
    if (!claimed.rowCount) continue;

    const message = personalize(settings.silent_follow_up_message, row);
    try {
      const telegramMessage = await bot.telegram.sendMessage(
        row.chat_id, message, await studentMenuOptions(row.chat_id));
      await pool.query(
        `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id)
         VALUES ($1, NULL, $2, $3)`,
        [row.id, message, telegramMessage.message_id]);
      await pool.query(
        `UPDATE tickets SET last_message_at = NOW(),
          status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END
         WHERE id = $1`, [row.id]);
      sent += 1;
    } catch (error) {
      failed += 1;
      // الطالب اللي حاظر البوت مابيتحاولش تاني — الحجز فوق بيمنع التكرار في الحالتين،
      // والفرق إن الدايم بيتسجّل مرة واحدة بدل ما يملّي اللوج كل ساعة
      if (isPermanentSendError(error)) {
        console.error(`⛔ Silent follow-up for ticket #${row.id} will not be retried:`, error.message);
      } else {
        console.error(`❌ Silent follow-up failed for ticket #${row.id}:`, error.message);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (sent || failed) console.log(`💤 Silent follow-ups: ${sent} sent, ${failed} failed.`);
  return { sent, failed, considered: rows.length };
}

function startSilentFollowUp() {
  cron.schedule('7 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      await runSilentFollowUps();
    } catch (error) {
      console.error('❌ Silent follow-up job failed:', error.message);
    } finally {
      running = false;
    }
  });
  console.log(`✅ Silent follow-up job started; up to ${BATCH_LIMIT} students per hour between ${SEND_FROM_HOUR}:00 and ${SEND_TO_HOUR}:00 Cairo.`);
}

module.exports = { startSilentFollowUp, runSilentFollowUps, BATCH_LIMIT, SEND_FROM_HOUR, SEND_TO_HOUR };
