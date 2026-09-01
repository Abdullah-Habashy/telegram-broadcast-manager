const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const { storeFile } = require('../utils/objectStorage');
const botManager = require('../bot/botManager');
const { prepareVoiceForTelegram } = require('../utils/voiceNote');

// ---------- رسالة صوتية من الموظف للطالب ----------
//
// اتجاه واحد بس: الموظف بيسجّل ويبعت، والطالب مابيبعتش صوت (بيتردّ عليه يبعت مكتوب أو صورة
// في bot/handlers/message.js). السبب إن الموظف بيقرا وبيرد على شاشة، والطالب بيبعت من موبايل
// والصوت الجاي منه كان بيضيع من غير ما حد يشوفه.
//
// مسار منفصل عن replyToTicket بدل ما نحشر فرع تالت جوّاه: الرد النصي والصورة بيتشاركوا نفس
// التحقق من الطول ونفس multer، والصوت له حدوده وصيغه وتحويله — دمجهم كان هيخلي الدالة تفرّع
// على نوع الملف في خمس مواضع مختلفة
async function sendVoiceNote(req, res) {
  const ticketId = Number(req.params.id);
  const cleanup = () => { if (req.file?.path) fs.unlink(req.file.path, () => {}); };

  if (!Number.isInteger(ticketId)) { cleanup(); return res.status(400).json({ error: 'التذكرة غير صالحة' }); }
  if (!req.file) return res.status(400).json({ error: 'مفيش تسجيل مرفق' });

  const bot = botManager.getBot();
  if (!bot) { cleanup(); return res.status(503).json({ error: 'البوت غير متصل حاليًا' }); }

  let preparedPath = null;
  // **الحارس ده هو بيت القصيد.** التسجيل أول ما يوصل الطالب بيبقى نسخة الموظف من رسالة
  // اتبعتت فعلًا — فأي فشل بعد كده (تسجيل في القاعدة، تحديث تذكرة) مايصحش يمسحه، وإلا
  // بيفضل في المحادثة صف بيشاور على ملف مش موجود. نفس المنطق في مسار الصور بالظبط
  let telegramSent = false;
  try {
    const ticketResult = await pool.query(
      `SELECT t.id, c.chat_id FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       JOIN users u ON u.id = $2 AND u.is_active = TRUE
       WHERE t.id = $1`,
      [ticketId, req.session.userId]
    );
    if (!ticketResult.rows[0]) { cleanup(); return res.status(404).json({ error: 'التذكرة غير موجودة' }); }

    // التحويل قبل الإرسال: كروم وإيدچ بيسجّلوا webm وتليجرام بيرفضها
    preparedPath = await prepareVoiceForTelegram(req.file.path);

    const telegramMessage = await bot.telegram.sendVoice(
      ticketResult.rows[0].chat_id,
      { source: preparedPath }
    );
    telegramSent = true;

    // بعد ما الصوت وصل الطالب: الملف بقى أرشيف، فبيروح السحابة لو متظبّطة
    const localVoicePath = `uploads/support/${path.basename(preparedPath)}`;
    const storedPath = await storeFile(preparedPath, localVoicePath);
    const result = await pool.query(
      `INSERT INTO support_messages (ticket_id, sent_by, content, voice_path, telegram_message_id)
       VALUES ($1, $2, '', $3, $4) RETURNING *`,
      [ticketId, req.session.userId, storedPath, telegramMessage.message_id]
    );
    await pool.query(
      `UPDATE tickets SET
        status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END,
        assigned_to = COALESCE(assigned_to, $2),
        last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [ticketId, req.session.userId]
    );
    await pool.query('UPDATE contacts SET last_contacted_at = NOW() WHERE chat_id = $1',
      [ticketResult.rows[0].chat_id]);

    res.json(result.rows[0]);
  } catch (error) {
    // قبل الإرسال: تسجيل مالوش لازمة، يتمسح. بعد الإرسال: الطالب سمعه، فبيفضل على القرص
    // عشان الموظف يلاقيه في المحادثة
    if (!telegramSent) {
      if (preparedPath && preparedPath !== req.file?.path) fs.unlink(preparedPath, () => {});
      cleanup();
    }
    console.error('❌ Failed to send a voice note:', error.message);
    res.status(500).json({ error: error.message || 'تعذر إرسال التسجيل الصوتي' });
  }
}

module.exports = { sendVoiceNote };
