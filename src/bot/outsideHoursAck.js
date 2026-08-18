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

  const telegramMessage = await ctx.reply(text);
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
