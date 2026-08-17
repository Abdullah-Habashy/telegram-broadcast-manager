const cron = require('node-cron');
const pool = require('../config/db');
const botManager = require('../bot/botManager');
const { getFirstName } = require('../utils/messagePersonalization');
const { isWithinWorkingHours, currentCairoTime } = require('../utils/workingHours');
const events = require('../utils/events');
const { notifyEmployeesOfIncomingMessage } = require('../bot/handlers/message');

// دفعة صغيرة كل مرة عشان تشغيلة الكرون ما تاخدش وقت طويل لو الطابور فيه رصيد كبير — الباقي هيتبعت
// في التشغيلات الجاية لسه احنا داخل وقت العمل
const BATCH_SIZE = 30;
const DELAY_MS = 250;

let running = false;

// بيبعت رسالة الترحيب الموحدة المتراكمة في الطابور (pending_welcome_sends) — بس لو الخاصية مفعّلة
// ولو دلوقتي داخل وقت العمل المحدد (settings.working_hours_start/end). التذكرة والإسناد بالتبادل
// كانوا اتعملوا فورًا وقت الـ Start، فمفيش أي تأخير في التوزيع — بس الرسالة الفعلية هي اللي بتستنى
async function sendPendingWelcomeMessages() {
  if (running) return;
  running = true;
  try {
    const settingsResult = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
        ('welcome_message_enabled', 'welcome_message_text', 'working_hours_start', 'working_hours_end')`
    );
    const settings = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
    if (settings.welcome_message_enabled !== 'true' || !settings.welcome_message_text) return;

    const start = settings.working_hours_start || '00:00';
    const end = settings.working_hours_end || '23:59';
    if (!isWithinWorkingHours(start, end, currentCairoTime())) return;

    const bot = botManager.getBot();
    if (!bot) return;

    const pendingResult = await pool.query(
      `SELECT p.contact_id, p.ticket_id, c.chat_id, c.first_name, c.telegram_username, t.assigned_to, u.name AS agent_name,
        (SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1) AS tafra_name
       FROM pending_welcome_sends p
       JOIN contacts c ON c.id = p.contact_id
       JOIN tickets t ON t.id = p.ticket_id
       LEFT JOIN users u ON u.id = t.assigned_to
       ORDER BY p.created_at
       LIMIT $1`,
      [BATCH_SIZE]
    );

    for (const row of pendingResult.rows) {
      const studentName = (row.tafra_name || row.first_name || row.telegram_username || String(row.chat_id)).trim();
      try {
        const messageText = settings.welcome_message_text
          .replaceAll(
            'الاسم',
            getFirstName({ tafra_name: row.tafra_name, first_name: row.first_name, telegram_username: row.telegram_username })
          )
          .replaceAll('الموظف', row.agent_name || 'فريق المتابعة');
        const telegramMessage = await bot.telegram.sendMessage(row.chat_id, messageText);
        await pool.query(
          `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id, is_welcome)
           VALUES ($1, NULL, $2, $3, TRUE)`,
          [row.ticket_id, messageText, telegramMessage.message_id]
        );
        await pool.query('DELETE FROM pending_welcome_sends WHERE contact_id = $1', [row.contact_id]);

        try {
          events.notifyNewIncomingMessage({
            ticket_id: row.ticket_id, contact_id: row.contact_id, student_name: studentName, chat_id: row.chat_id,
            content: messageText, image_path: null, received_at: new Date().toISOString(),
          });
        } catch (eventErr) {
          console.error('❌ Failed to emit SSE event for queued welcome message:', eventErr.message);
        }
        notifyEmployeesOfIncomingMessage({ id: row.ticket_id, assigned_to: row.assigned_to }, { studentName, content: messageText })
          .catch((pushErr) => console.error('❌ Failed to send push notification for queued welcome message:', pushErr.message));
      } catch (error) {
        console.error(`❌ Failed to send queued welcome message to contact #${row.contact_id}:`, error.message);
        // لو فشل الإرسال (زي طالب حاظر البوت)، بنشيله من الطابور عشان مايتكررش المحاولة له كل مرة
        await pool.query('DELETE FROM pending_welcome_sends WHERE contact_id = $1', [row.contact_id]).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  } catch (error) {
    console.error('❌ Failed to process pending welcome sends:', error.message);
  } finally {
    running = false;
  }
}

function startWelcomeMessageSender() {
  cron.schedule('*/2 * * * *', () => {
    sendPendingWelcomeMessages().catch((err) => console.error('❌ Failed to run welcome message sender:', err.message));
  });
  console.log('✅ Welcome message sender scheduler started; checking every 2 minutes.');
}

module.exports = { startWelcomeMessageSender, sendPendingWelcomeMessages };
