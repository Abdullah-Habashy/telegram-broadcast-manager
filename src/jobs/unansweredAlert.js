const cron = require('node-cron');
const pool = require('../config/db');
const botManager = require('../bot/botManager');
const push = require('../utils/push');
const { isWithinWorkingHours, currentCairoTime } = require('../utils/workingHours');

// تنبيه على الرسائل اللي عدّى عليها يوم من غير رد.
//
// السبب: وسيط أول رد بشري ١.٨ ساعة، لكن أبطأ ١٠٪ بيستنوا ٦٥ ساعة. يعني الفريق سريع على اللي
// شايفه، والمشكلة في التذاكر اللي بتنزل تحت في القايمة وتختفي. التنبيه ده بيرجّعها للسطح.
//
// بيتبعت **ملخص واحد لكل موظف** مش إشعار لكل تذكرة: أول تشغيلة لوحدها فيها ٦٣ تذكرة موزّعة على
// تلات موظفين، ولو كل تذكرة بإشعار كان الفريق هيقفل الإشعارات من أول يوم
const ALERT_AFTER_HOURS = 24;

// سقف أعلى للنافذة: تذكرة رسالتها الأخيرة بقالها أكتر من أسبوع مش "فاتت من الشبكة"، دي محتاجة
// قرار مش تنبيه. من غير السقف ده الملخص بيتحوّل لقايمة دائمة محدش بيبصلها
const ALERT_WINDOW_DAYS = 7;

// أكتر عدد أسماء بتتكتب في الرسالة — الباقي بيتلخّص في "و N غيرهم"
const NAMES_IN_MESSAGE = 5;

let running = false;

// الشرط الأساسي: آخر رسالة في المحادثة واردة من الطالب (يعني مفيش رد بعدها)، وعدّى عليها
// ALERT_AFTER_HOURS، ولسه جوه نافذة الأسبوع. رسايل الإرسال الجماعي والمتابعة التلقائية
// (broadcast_recipient_id أو sent_by IS NULL) مش محسوبة "رد" — الطالب اللي اتبعتله حملة
// ولسه مستني إجابة على سؤاله لسه مستني
const PENDING_TICKETS_SQL = `
  SELECT t.id, t.assigned_to, last_in.received_at,
    COALESCE(NULLIF(TRIM(tafra.name), ''), NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
      NULLIF(c.telegram_username, ''), 'طالب') AS student_name,
    ROUND(EXTRACT(EPOCH FROM (NOW() - last_in.received_at)) / 3600)::int AS hours_waiting
  FROM tickets t
  JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN LATERAL (
    SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
  ) tafra ON true
  JOIN LATERAL (
    SELECT MAX(im.received_at) AS received_at FROM incoming_messages im WHERE im.contact_id = c.id
  ) last_in ON true
  LEFT JOIN LATERAL (
    SELECT MAX(sm.sent_at) AS sent_at FROM support_messages sm
    WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL
      AND sm.sent_by IS NOT NULL AND sm.broadcast_recipient_id IS NULL
  ) last_reply ON true
  WHERE t.status NOT IN ('resolved', 'closed')
    AND last_in.received_at < NOW() - ($1 * INTERVAL '1 hour')
    AND last_in.received_at > NOW() - ($2 * INTERVAL '1 day')
    AND (last_reply.sent_at IS NULL OR last_reply.sent_at < last_in.received_at)
    AND (t.unanswered_alert_at IS NULL OR t.unanswered_alert_at < last_in.received_at)
  ORDER BY last_in.received_at
`;

// العدد في العربي بيغيّر صيغة المعدود: واحدة / اتنين / ٣-١٠ جمع / ١١+ مفرد. من غير ده
// بتطلع رسايل زي "39 رسايل" و"2 ساعة" — غلط واضح في نص بيتبعت للفريق كل يوم
function arabicCount(count, { one, two, few, many }) {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count <= 10) return `${count} ${few}`;
  return `${count} ${many}`;
}

// فوق يومين الساعات بتبقى صعبة القراءة: "مستني 160 ساعة" مش بتوصل زي "مستني 6 أيام"
function waitedFor(hours) {
  if (hours < 48) return arabicCount(hours, { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' });
  return arabicCount(Math.floor(hours / 24), { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يوم' });
}

function buildMessage(tickets) {
  const shown = tickets.slice(0, NAMES_IN_MESSAGE);
  const rest = tickets.length - shown.length;
  const headline = arabicCount(tickets.length, {
    one: 'رسالة', two: 'رسالتين', few: 'رسايل', many: 'رسالة',
  });
  const lines = [`⏰ فيه ${headline} بقالها يوم من غير رد:`];
  shown.forEach((ticket) => {
    lines.push(`• ${ticket.student_name} — مستني ${waitedFor(ticket.hours_waiting)}`);
  });
  if (rest > 0) lines.push(`• و${rest} غيرهم`);
  return lines.join('\n');
}

// إشعار المتصفح + رسالة تليجرام مع بعض عن قصد: الاتنين تغطيتهم ناقصة لوحدهم — فيه موظفين
// مربوطين بتليجرام من غير اشتراك إشعارات والعكس، فالاتنين مع بعض هما اللي بيضمنوا وصول التنبيه
async function notifyRecipient(user, tickets) {
  const message = buildMessage(tickets);
  const results = await Promise.allSettled([
    push.sendToUser(user.id, {
      title: 'رسايل مستنية رد',
      body: message,
      tag: 'unanswered-digest',
      // أول تذكرة في القايمة هي الأقدم، فالضغط على الإشعار بيفتح اللي مستني أكتر حاجة
      url: `/?ticket=${tickets[0].id}`,
    }),
    user.telegram_chat_id && botManager.getBot()
      ? botManager.getBot().telegram.sendMessage(user.telegram_chat_id, message)
      : Promise.resolve(),
  ]);
  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error(`❌ Failed to alert user #${user.id} about unanswered tickets:`, result.reason?.message);
    }
  });
}

async function sendUnansweredAlerts() {
  if (running) return;
  running = true;
  try {
    // مواعيد العمل بتتقرا من نفس إعداد رسايل الطلاب، لكن **من غير** شرط working_hours_enabled:
    // الإعداد ده بيتحكم في إيقاف الرد على الطلاب بره الوقت، ومالوش علاقة بإن الموظف مايتصحّاش
    // الساعة تلاتة الفجر. لو الإعداد مش موجود بنستخدم نافذة نهار معقولة
    const settingsResult = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('working_hours_start', 'working_hours_end')"
    );
    const settings = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
    const start = settings.working_hours_start || '09:00';
    const end = settings.working_hours_end || '22:00';
    if (!isWithinWorkingHours(start, end, currentCairoTime())) return;

    const { rows: tickets } = await pool.query(PENDING_TICKETS_SQL, [ALERT_AFTER_HOURS, ALERT_WINDOW_DAYS]);
    if (!tickets.length) return;

    // التذاكر غير المسندة مالهاش موظف يتنبّه، فبتروح للأدمن — هو الوحيد اللي بيقدر يسندها
    const adminsResult = await pool.query(
      "SELECT id, telegram_chat_id FROM users WHERE is_active = TRUE AND role = 'admin'"
    );
    const agentsResult = await pool.query(
      'SELECT id, telegram_chat_id FROM users WHERE is_active = TRUE AND id = ANY($1::int[])',
      [[...new Set(tickets.map((ticket) => ticket.assigned_to).filter(Boolean))]]
    );
    const agents = new Map(agentsResult.rows.map((row) => [row.id, row]));

    const byRecipient = new Map();
    const addFor = (user, ticket) => {
      if (!byRecipient.has(user.id)) byRecipient.set(user.id, { user, tickets: [] });
      byRecipient.get(user.id).tickets.push(ticket);
    };
    tickets.forEach((ticket) => {
      const agent = ticket.assigned_to && agents.get(ticket.assigned_to);
      if (agent) addFor(agent, ticket);
      else adminsResult.rows.forEach((admin) => addFor(admin, ticket));
    });

    for (const { user, tickets: userTickets } of byRecipient.values()) {
      await notifyRecipient(user, userTickets);
    }

    // الوسم بيتم بعد الإرسال: لو التشغيلة وقعت في النص، التذاكر اللي ما اتبعتش عنها حاجة
    // بتفضل بلا وسم وبتتنبّه في التشغيلة الجاية بدل ما تضيع بالسكوت
    await pool.query(
      'UPDATE tickets SET unanswered_alert_at = NOW() WHERE id = ANY($1::int[])',
      [tickets.map((ticket) => ticket.id)]
    );
    console.log(`⏰ Alerted ${byRecipient.size} user(s) about ${tickets.length} unanswered ticket(s).`);
  } finally {
    running = false;
  }
}

function startUnansweredAlert() {
  cron.schedule('0 * * * *', () => {
    sendUnansweredAlerts().catch((err) =>
      console.error('❌ Failed to run the unanswered-tickets alert:', err.message)
    );
  });
  console.log('✅ Unanswered-tickets alert started; checking every hour during working hours.');
}

module.exports = { startUnansweredAlert, sendUnansweredAlerts };
