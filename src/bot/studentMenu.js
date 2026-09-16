// ---------- قايمة الطالب: الزرار الأزرق (Menu) ----------
//
// **الزراير كانت كيبورد تحت مربع الكتابة، وبقت قايمة أوامر (١٦ سبتمبر ٢٠٢٦).**
//
// السبب إن **تيليجرام بيقفل أي رسالة اتبعتت ومعاها reply keyboard ضد التعديل** — بيرد
// `message can't be edited`. والكيبورد كان بيتبعت مع كل رسالة رايحة، فمن ٥ سبتمبر بقى
// مفيش ولا رد موظف قابل للتعديل: ٤١٠ تعديل ناجح كلهم قبل التاريخ ده، وصفر بعده.
// قايمة الأوامر مالهاش الأثر ده لأنها مش متعلّقة برسالة أصلًا.
//
// **مين يشوف إيه:**
//   المشترك في كورس مدفوع → الدعم العلمي + الدعم الفني + المتابعة + التقرير
//   غير المشترك           → الدعم الفني + التقرير
// التفرقة في `utils/studentAccess.js`، ومكتوبة مرة واحدة عشان الأمر اللي بيبان يبقى هو
// الأمر اللي بيشتغل.
//
// **الافتراضي بيتسجّل لكل البوت** في `botManager`، والمشترك بياخد نطاق `chat` خاص بيه أول
// ما يتعامل مع البوت. تيليجرام بيقدّم نطاق المحادثة على الافتراضي، فمفيش تعارض — ومحادثة
// الأدمن ليها نطاقها الخاص في `handlers/adminReport.js` ومابتتأثرش بده خالص.
const pool = require('../config/db');
const { isSubscribedStudent } = require('../utils/studentAccess');

// نصوص الزراير القديمة — **سايبينها عن قصد.** الطالب اللي لسه الكيبورد عنده (لحد ما
// الرسالة الجاية تشيله) لازم زراره تفضل شغالة، و`handlers/studentTransfer.js` بيسمعها
const SCIENCE_BUTTON = '🧪 الدعم العلمي';
const TECH_BUTTON = '🛠️ الدعم الفني';
const FOLLOWUP_BUTTON = '👥 تيم المتابعة';

// الأوامر المتاحة لأي طالب مهما كانت حالته — أعطال المنصة بتحصل للكل، والتقرير بتاعه هو
const DEFAULT_STUDENT_COMMANDS = [
  { command: 'tech', description: '🛠️ مشكلة في المنصة أو الدفع' },
  { command: 'report', description: '📊 تقريري ومستواي' },
];

// المشترك بيزود عليها الدعم العلمي والرجوع للمتابعة
const SUBSCRIBED_STUDENT_COMMANDS = [
  { command: 'science', description: '🧪 اسأل الدعم العلمي' },
  { command: 'tech', description: '🛠️ مشكلة في المنصة أو الدفع' },
  { command: 'followup', description: '👥 ارجع لتيم المتابعة' },
  { command: 'report', description: '📊 تقريري ومستواي' },
];

// **أمر واحد بيشيل الكيبورد القديم.** تيليجرام مابيشيلش الكيبورد لوحده — لازم رسالة
// واحدة تقوله يشيله. الرسالة دي بالذات بتفضل غير قابلة للتعديل، وبعدها كل حاجة نضيفة
const REMOVE_KEYBOARD = { remove_keyboard: true };

async function menuState(chatId) {
  try {
    const { rows } = await pool.query(
      'SELECT student_menu_kind, keyboard_removed_at FROM contacts WHERE chat_id = $1', [chatId]);
    return rows[0] || {};
  } catch (error) {
    console.error(`❌ Failed to read the menu state of chat ${chatId}:`, error.message);
    return {};
  }
}

// بتسجّل قايمة الأوامر على محادثة الطالب لو حالته اتغيّرت (أو أول مرة).
// **مابتبعتش أي رسالة** — ده الفرق كله عن الكيبورد القديم.
async function ensureStudentCommands(telegram, chatId) {
  if (!telegram || !chatId) return;
  const kind = (await isSubscribedStudent(chatId)) ? 'full' : 'tech';
  const state = await menuState(chatId);
  if (state.student_menu_kind === kind) return;

  try {
    await telegram.setMyCommands(
      kind === 'full' ? SUBSCRIBED_STUDENT_COMMANDS : DEFAULT_STUDENT_COMMANDS,
      { scope: { type: 'chat', chat_id: Number(chatId) } }
    );
    await pool.query('UPDATE contacts SET student_menu_kind = $2 WHERE chat_id = $1', [chatId, kind]);
  } catch (error) {
    // القايمة مش لازمة لتشغيل الأوامر — الطالب لسه يقدر يكتب /tech بإيده
    console.error(`❌ Failed to set the command menu of chat ${chatId}:`, error.message);
  }
}

// بترجّع `{ reply_markup: { remove_keyboard: true } }` مرة واحدة بس لكل طالب لسه الكيبورد
// القديم عنده، وبعد كده `{}` — يعني الرسايل تفضل قابلة للتعديل
async function keyboardCleanup(chatId) {
  const state = await menuState(chatId);
  if (state.keyboard_removed_at) return {};
  try {
    await pool.query('UPDATE contacts SET keyboard_removed_at = NOW() WHERE chat_id = $1', [chatId]);
  } catch (error) {
    console.error(`❌ Failed to record the keyboard removal of chat ${chatId}:`, error.message);
    return {};
  }
  return { reply_markup: REMOVE_KEYBOARD };
}

// أغلب مواضع الإرسال بتبعت خيارات تانية (رد على رسالة، caption...)، فالدمج بيحصل هنا في
// مكان واحد بدل ما كل موضع يفتكر يحط `reply_markup` جنب خياراته
async function withStudentMenu(chatId, options = {}) {
  return { ...options, ...(await keyboardCleanup(chatId)) };
}

async function studentMenuOptions(chatId) {
  return keyboardCleanup(chatId);
}

// اسم متسايب عشان `/start` والترحيب مايتغيّروش — دلوقتي مفيش فرق بينهم وبين العادي، لأن
// القايمة الزرقا بتتسجّل لوحدها ومش محتاجة رسالة تشيلها
async function studentMenuOptionsAlways(chatId) {
  return keyboardCleanup(chatId);
}

module.exports = {
  SCIENCE_BUTTON,
  TECH_BUTTON,
  FOLLOWUP_BUTTON,
  DEFAULT_STUDENT_COMMANDS,
  SUBSCRIBED_STUDENT_COMMANDS,
  ensureStudentCommands,
  studentMenuOptions,
  studentMenuOptionsAlways,
  withStudentMenu,
};
