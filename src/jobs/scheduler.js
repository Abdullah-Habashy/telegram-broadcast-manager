const cron = require('node-cron');
const pool = require('../config/db');
const { sendBroadcast, getFirstName } = require('../bot/broadcastSender');
const botManager = require('../bot/botManager');

let followUpJobRunning = false;

// استبدال "الاسم" و"رقم الفكرة" في نص رسالة المتابعة التلقائية ببيانات الطالب الفعلية
function personalizeFollowUpMessage(template, student) {
  let result = template.replaceAll('الاسم', getFirstName(student));
  const ideaPhrase = student.current_idea_number
    ? `فكرة رقم ${student.current_idea_number}`
    : 'الفكرة المتفق عليها';
  result = result.replaceAll('رقم الفكرة', ideaPhrase);
  return result;
}

async function sendDueTicketFollowUps() {
  if (followUpJobRunning) return;
  followUpJobRunning = true;
  try {
    const settingsResult = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('follow_up_auto_enabled', 'follow_up_auto_message')"
    );
    const settings = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
    if (settings.follow_up_auto_enabled !== 'true' || !settings.follow_up_auto_message) return;

    const bot = botManager.getBot();
    if (!bot) return;

    const dueResult = await pool.query(
      `SELECT id FROM tickets
       WHERE next_follow_up_at <= NOW() AND status NOT IN ('resolved', 'closed')
       ORDER BY next_follow_up_at
       LIMIT 100`
    );

    for (const ticket of dueResult.rows) {
      const claimResult = await pool.query(
        `UPDATE tickets t SET next_follow_up_at = NULL, updated_at = NOW()
         FROM contacts c
         LEFT JOIN LATERAL (
           SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
         ) tafra_match ON true
         WHERE t.id = $1 AND t.contact_id = c.id AND t.next_follow_up_at <= NOW()
         RETURNING t.id, t.current_idea_number, c.chat_id, c.first_name, c.telegram_username, tafra_match.name AS tafra_name`,
        [ticket.id]
      );
      const claimed = claimResult.rows[0];
      if (!claimed) continue;

      try {
        const personalizedMessage = personalizeFollowUpMessage(settings.follow_up_auto_message, claimed);
        const telegramMessage = await bot.telegram.sendMessage(claimed.chat_id, personalizedMessage);
        await pool.query(
          `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id)
           VALUES ($1, NULL, $2, $3)`,
          [claimed.id, personalizedMessage, telegramMessage.message_id]
        );
        await pool.query(
          `UPDATE tickets SET
            status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END,
            last_message_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [claimed.id]
        );
        console.log(`✅ Automatic follow-up sent for ticket #${claimed.id}.`);
      } catch (error) {
        await pool.query(
          "UPDATE tickets SET next_follow_up_at = NOW() + INTERVAL '5 minutes', updated_at = NOW() WHERE id = $1",
          [claimed.id]
        );
        console.error(`❌ Automatic follow-up failed for ticket #${claimed.id}; retrying in 5 minutes:`, error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  } catch (error) {
    console.error('❌ Failed to process due ticket follow-ups:', error.message);
  } finally {
    followUpJobRunning = false;
  }
}

// كل دقيقة: يدوّر على أي broadcast متجدول ووقته وصل، ويبعته
function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try {
      const result = await pool.query(
        `SELECT id FROM broadcasts
         WHERE status = 'pending' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW()`
      );
      for (const row of result.rows) {
        console.log(`⏰ Scheduled broadcast #${row.id} is due; sending now.`);
        sendBroadcast(row.id).catch((err) =>
          console.error(`❌ Failed to send broadcast #${row.id}:`, err.message)
        );
      }
      await sendDueTicketFollowUps();
    } catch (err) {
      console.error('❌ Failed to check scheduled broadcasts:', err.message);
    }
  });
  console.log('✅ Broadcast scheduler started; checking every minute.');
}

module.exports = { startScheduler };
