// رد فوري للطالب اللي أول ارتباط له بالبوت حصل خارج مواعيد العمل.
//
// السياق: رسالة الترحيب الموحدة بتستنى وقت العمل عن قصد (welcomeMessageSender.js)، فطالب بيدخل
// 11 بالليل كان بيقعد لحد الصبح من غير أي رد خالص — التذكرة بتتعمل وتتسند فورًا بس هو مايعرفش.
// الرد ده بيسدّ الفراغ ده: بيأكّد له إنه اتسجّل وبيقوله هيتواصلوا معاه امتى بالظبط.
//
// ⚠️ الشرط هنا لازم يبقى **نفس** شرط welcomeMessageSender.js بالحرف (نفس المفاتيح ونفس القيم
// الافتراضية '00:00'/'23:59'). لو اختلفوا، ممكن نبعت "هنكلمك بكرة" والسيرفر يبعت الترحيب بعدها
// بدقيقتين — أو العكس فيقعد الطالب من غير رد. أي تعديل في مواعيد أحدهم لازم يتزامن مع التاني.
const pool = require('../config/db');
const { isWithinWorkingHours, currentCairoTime, nextWorkingWindowPhrase } = require('../utils/workingHours');
const { getFirstName } = require('../utils/messagePersonalization');
const aiReply = require('../utils/aiReply');
const { STUDENT_MENU_OPTIONS } = require('./studentMenu');

// بترجع true لو بعتت فعلاً — عشان اللي بينداها يعرف إنه مايبعتش رد تاني بعدها
async function sendOutsideHoursAck(ctx, { ticketId, contact }) {
  const result = await pool.query(
    `SELECT key, value FROM settings WHERE key IN
      ('outside_hours_ack_enabled', 'outside_hours_ack_text', 'working_hours_start', 'working_hours_end')`
  );
  const settings = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  if (settings.outside_hours_ack_enabled !== 'true' || !settings.outside_hours_ack_text) return false;

  const start = settings.working_hours_start || '00:00';
  const end = settings.working_hours_end || '23:59';
  const now = currentCairoTime();
  // جوه وقت العمل رسالة الترحيب نفسها جاية في دقيقتين، فرد إضافي هنا يبقى رسالتين ورا بعض
  if (isWithinWorkingHours(start, end, now)) return false;

  // اسم المنصة بيتجاب هنا مش من المنادي: الهاندلرز عندها بيانات تيليجرام بس، وأول نسخة من
  // الكود ده كانت بتبعت اسم تيليجرام بينما رسالة الترحيب نفسها بتنده باسم المنصة — نفس الطالب
  // كان بيتنده باسمين مختلفين في رسالتين ورا بعض
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  const tafraResult = await pool.query(
    'SELECT name, gender FROM tafra_students WHERE telegram_chat_id = $1 LIMIT 1',
    [chatId]
  );
  const text = settings.outside_hours_ack_text
    .replaceAll('{when}', nextWorkingWindowPhrase(start, now))
    .replaceAll('الاسم', getFirstName({
      ...contact,
      tafra_name: tafraResult.rows[0]?.name,
      gender: tafraResult.rows[0]?.gender,
    }));

  // محاولة الرد الآلي قبل رسالة الانتظار: لو النموذج لقى الإجابة في قاعدة المعرفة، الطالب
  // بياخد إجابته فورًا بدل ما يستنى للصبح. ولو ملقاش — أو الموضوع ممنوع أو حصل أي خطأ —
  // بنكمّل لرسالة الانتظار العادية زي ما كانت بالظبط.
  //
  // **الفشل هنا مايوقفش حاجة**: أي مشكلة في النموذج أو الشبكة معناها الطالب ياخد رسالة
  // الانتظار، مش إنه يقعد من غير أي رد
  const question = String(ctx.message?.text || '').trim();
  if (question && aiReply.isEnabled()) {
    try {
      const result = await aiReply.generateReply({ question });
      await aiReply.logAttempt({ ticketId, incomingMessageId: null, question, result })
        .catch((err) => console.error('❌ Failed to log the AI reply attempt:', err.message));
      // 'asked' بيتبعت زي 'sent' — الاتنين رسالة رايحة للطالب
      if (result.outcome === 'sent' || result.outcome === 'asked') {
        const aiMessage = await ctx.reply(result.answer, STUDENT_MENU_OPTIONS);
        await pool.query(
          `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id, is_ai)
           VALUES ($1, NULL, $2, $3, TRUE)`,
          [ticketId, result.answer, aiMessage.message_id]
        );
        return true;
      }
    } catch (error) {
      console.error('❌ AI reply failed, falling back to the waiting message:', error.message);
    }
  }

  const telegramMessage = await ctx.reply(text, STUDENT_MENU_OPTIONS);
  // بيتسجّل في المحادثة (بدون is_welcome) عشان الموظف يشوف الطالب استلم إيه ومايكرّرش نفس الكلام.
  // is_welcome بتفضل false لأن دي مش رسالة الترحيب — دي إشعار انتظار، ولو علّمناها كترحيب
  // كانت هتفسد فلتر حالة الترحيب في شاشة طلاب المنصة
  await pool.query(
    `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id)
     VALUES ($1, NULL, $2, $3)`,
    [ticketId, text, telegramMessage.message_id]
  );
  return true;
}

module.exports = { sendOutsideHoursAck };
