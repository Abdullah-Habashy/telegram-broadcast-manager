const pool = require('../config/db');
const path = require('path');
const botManager = require('./botManager');
const { getNextTicketAssignee } = require('../utils/ticketAssignment');
const { getFirstName } = require('../utils/messagePersonalization');

// تأخير بسيط بين كل رسالة عشان نتجنب حدود معدل الإرسال بتاعة تليجرام
const DELAY_MS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// استبدال كلمات "الاسم"/"اختبار"/"الدرجة" في نص الرسالة الجماعية وقت الإرسال لكل طالب
// examContext = { name, marksByChatId } أو null لو مفيش اختبار مربوط بعملية الإرسال دي
function personalizeMessage(content, contact, examContext) {
  if (!content) return content;
  let result = content.replaceAll('الاسم', getFirstName(contact));
  if (examContext) {
    result = result.replaceAll('اختبار', examContext.name);
    const mark = examContext.marksByChatId.get(String(contact.chat_id));
    result = result.replaceAll('الدرجة', mark !== undefined ? String(mark) : 'لم يدخل الاختبار');
  }
  return result;
}

// يجيب اسم الاختبار ودرجة كل طالب مرة واحدة قبل حلقة الإرسال، بدل استعلام لكل طالب على حدة
async function loadExamContext(broadcast) {
  if (!broadcast.context_exam_type || !broadcast.context_exam_id) return null;
  const examResult = await pool.query(
    'SELECT name FROM tafra_exams WHERE exam_type = $1 AND tafra_exam_id = $2',
    [broadcast.context_exam_type, broadcast.context_exam_id]
  );
  if (!examResult.rows[0]) return null;

  const marksResult = await pool.query(
    `SELECT ts.telegram_chat_id, tem.mark
     FROM tafra_exam_marks tem
     JOIN tafra_students ts ON ts.tafra_student_id = tem.tafra_student_id
     WHERE tem.exam_type = $1 AND tem.tafra_exam_id = $2 AND ts.telegram_chat_id IS NOT NULL`,
    [broadcast.context_exam_type, broadcast.context_exam_id]
  );
  const marksByChatId = new Map(marksResult.rows.map((row) => [String(row.telegram_chat_id), row.mark]));

  return { name: examResult.rows[0].name.trim(), marksByChatId };
}

async function sendBroadcast(broadcastId) {
  const bot = botManager.getBot();
  if (!bot) {
    console.error(`❌ Cannot send broadcast #${broadcastId}: no bot is connected (configure the token in Settings).`);
    await pool.query("UPDATE broadcasts SET status = 'failed' WHERE id = $1", [broadcastId]);
    return;
  }

  const broadcastResult = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [broadcastId]);
  const broadcast = broadcastResult.rows[0];
  if (!broadcast) return;

  await pool.query("UPDATE broadcasts SET status = 'sending' WHERE id = $1", [broadcastId]);
  const examContext = await loadExamContext(broadcast);

  const currentBotAudience = `(c.source <> 'tafra' OR c.last_contacted_at IS NOT NULL)`;
  // بنجيب اسم الطالب من منصة طفرة (LATERAL + LIMIT 1 لأن الفهرس على telegram_chat_id مش UNIQUE،
  // فمحتمل يبقى فيه أكتر من طالب على نفس رقم تيليجرام) عشان نستخدمه في استبدال كلمة "الاسم"
  const tafraNameJoin = `LEFT JOIN LATERAL (
    SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
  ) tafra_match ON true`;
  let contactsQuery = `SELECT c.*, tafra_match.name AS tafra_name FROM contacts c ${tafraNameJoin} WHERE ${currentBotAudience}`;
  let contactsParams = [];

  if (broadcast.selected_contact_ids?.length) {
    contactsQuery = `SELECT c.*, tafra_match.name AS tafra_name FROM contacts c ${tafraNameJoin}
      WHERE c.id = ANY($1::int[]) AND ${currentBotAudience} ORDER BY c.id`;
    contactsParams = [broadcast.selected_contact_ids];
  } else if (broadcast.filter_tag_id) {
    contactsQuery = `SELECT c.*, tafra_match.name AS tafra_name FROM contacts c
      JOIN contact_tags ct ON ct.contact_id = c.id
      ${tafraNameJoin}
      WHERE ct.tag_id = $1 AND ${currentBotAudience}`;
    contactsParams = [broadcast.filter_tag_id];
  }
  const contactsResult = await pool.query(contactsQuery, contactsParams);
  const contacts = contactsResult.rows;

  for (const contact of contacts) {
    const recipientRow = await pool.query(
      "INSERT INTO broadcast_recipients (broadcast_id, contact_id, status) VALUES ($1, $2, 'pending') RETURNING id",
      [broadcastId, contact.id]
    );
    const recipientId = recipientRow.rows[0].id;

    try {
      const personalizedContent = personalizeMessage(broadcast.message_content, contact, examContext);
      const replyMarkup = broadcast.button_text && broadcast.button_url
        ? { inline_keyboard: [[{ text: broadcast.button_text, url: broadcast.button_url }]] }
        : undefined;
      if (broadcast.image_path) {
        const imagePath = path.join(__dirname, '..', '..', 'public', broadcast.image_path);
        await bot.telegram.sendPhoto(
          contact.chat_id,
          { source: imagePath },
          { caption: personalizedContent, reply_markup: replyMarkup }
        );
      } else {
        await bot.telegram.sendMessage(contact.chat_id, personalizedContent, { reply_markup: replyMarkup });
      }
      await pool.query(
        "UPDATE broadcast_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1",
        [recipientId]
      );
      // لو الطالب لسه مالوش تذكرة (مثلاً دوس Start بس وإحنا اللي بادرنا بالمراسلة)، لازم ننشئلها هنا —
      // وإلا الرسالة المُرسلة تفضل مسجّلة بس في broadcast_recipients من غير أي أثر في صندوق الدعم.
      // بنستخدم transaction (مش UPSERT عادي) عشان نفرّق بدقة بين "تذكرة جديدة تمامًا" (تاخد دور في
      // توزيع صندوق الدعم بالتبادل، زي أول رسالة من الطالب بالظبط) و"تذكرة موجودة بالفعل" (تتحدّث بس)
      const ticketClient = await pool.connect();
      let ticketId;
      try {
        await ticketClient.query('BEGIN');
        const existingTicket = await ticketClient.query(
          'SELECT id FROM tickets WHERE contact_id = $1 FOR UPDATE',
          [contact.id]
        );
        if (existingTicket.rows[0]) {
          const updateResult = await ticketClient.query(
            'UPDATE tickets SET last_message_at = NOW(), updated_at = NOW() WHERE contact_id = $1 RETURNING id',
            [contact.id]
          );
          ticketId = updateResult.rows[0].id;
        } else {
          const nextAssignee = await getNextTicketAssignee(ticketClient);
          const insertResult = await ticketClient.query(
            `INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, updated_at, assigned_to)
             VALUES ($1, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'), 0, NOW(), NOW(), $2)
             RETURNING id`,
            [contact.id, nextAssignee]
          );
          ticketId = insertResult.rows[0].id;
        }
        await ticketClient.query('COMMIT');
      } catch (error) {
        await ticketClient.query('ROLLBACK');
        throw error;
      } finally {
        ticketClient.release();
      }
      await pool.query(
        `INSERT INTO support_messages
          (ticket_id, sent_by, content, image_path, broadcast_recipient_id, sent_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [ticketId, broadcast.created_by, personalizedContent, broadcast.image_path, recipientId]
      );
      await pool.query('UPDATE contacts SET last_contacted_at = NOW() WHERE id = $1', [contact.id]);
    } catch (err) {
      await pool.query(
        "UPDATE broadcast_recipients SET status = 'failed', error_message = $2 WHERE id = $1",
        [recipientId, err.message]
      );
    }

    await sleep(DELAY_MS);
  }

  await pool.query("UPDATE broadcasts SET status = 'completed' WHERE id = $1", [broadcastId]);
  console.log(`✅ Broadcast #${broadcastId} completed for ${contacts.length} contact(s).`);
}

module.exports = { sendBroadcast, getFirstName };
