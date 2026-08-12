const cron = require('node-cron');
const pool = require('../config/db');
const botManager = require('../bot/botManager');

// ملخص مختصر كل ساعة لكل موظف رابط حسابه على تيليجرام (عبر /linkstaff) — بيجمع مكالماته وتحديثات
// أرقام الأفكار اللي عملها خلال الساعة اللي فاتت في رسالة واحدة، بدل إشعار منفصل لكل حدث. لو مفيش
// أي نشاط، محدش بيتبعتله رسالة فاضية
async function sendHourlyStaffDigest() {
  const bot = botManager.getBot();
  if (!bot) return;

  const staffResult = await pool.query(
    'SELECT id, name, telegram_chat_id FROM users WHERE is_active = TRUE AND telegram_chat_id IS NOT NULL'
  );
  if (!staffResult.rows.length) return;

  for (const staff of staffResult.rows) {
    try {
      const callsResult = await pool.query(
        `SELECT ts.name AS student_name, co.name AS outcome_name, cl.next_follow_up_at
         FROM call_logs cl
         JOIN tafra_students ts ON ts.tafra_student_id = cl.tafra_student_id
         LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
         WHERE cl.called_by = $1 AND cl.called_at >= NOW() - INTERVAL '1 hour'
         ORDER BY cl.called_at`,
        [staff.id]
      );
      const ideaResult = await pool.query(
        `SELECT COALESCE(tsm.name, c.first_name, c.telegram_username) AS student_name, ipl.idea_number
         FROM idea_progress_log ipl
         JOIN tickets t ON t.id = ipl.ticket_id
         JOIN contacts c ON c.id = t.contact_id
         LEFT JOIN LATERAL (
           SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
         ) tsm ON true
         WHERE ipl.changed_by = $1 AND ipl.changed_at >= NOW() - INTERVAL '1 hour'
         ORDER BY ipl.changed_at`,
        [staff.id]
      );

      if (!callsResult.rows.length && !ideaResult.rows.length) continue;

      const lines = ['📊 ملخص نشاطك خلال الساعة اللي فاتت:'];
      if (callsResult.rows.length) {
        lines.push(`\n📞 مكالمات (${callsResult.rows.length}):`);
        callsResult.rows.forEach((call) => {
          const name = (call.student_name || 'طالب').trim();
          const followUp = call.next_follow_up_at
            ? ` — متابعة: ${new Date(call.next_follow_up_at).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}`
            : '';
          lines.push(`• ${name}: ${call.outcome_name || 'بدون نتيجة'}${followUp}`);
        });
      }
      if (ideaResult.rows.length) {
        lines.push(`\n💡 تحديث أفكار (${ideaResult.rows.length}):`);
        ideaResult.rows.forEach((idea) => {
          const name = (idea.student_name || 'طالب').trim();
          lines.push(`• ${name}: فكرة ${idea.idea_number}`);
        });
      }

      await bot.telegram.sendMessage(staff.telegram_chat_id, lines.join('\n'));
    } catch (error) {
      console.error(`❌ Failed to send hourly activity digest to user #${staff.id}:`, error.message);
    }
  }
}

function startStaffActivityDigest() {
  cron.schedule('0 * * * *', () => {
    sendHourlyStaffDigest().catch((err) => console.error('❌ Failed to run staff activity digest:', err.message));
  });
  console.log('✅ Staff activity digest scheduler started; runs every hour.');
}

module.exports = { startStaffActivityDigest, sendHourlyStaffDigest };
