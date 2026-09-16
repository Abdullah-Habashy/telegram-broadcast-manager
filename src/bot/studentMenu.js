// ---------- قايمة الطالب الثابتة تحت مربع الكتابة ----------
//
// **القايمة بتتغيّر حسب اشتراك الطالب:**
//   مشترك في كورس مدفوع → الدعم العلمي + الدعم الفني + تيم المتابعة
//   غير مشترك (أو التأسيس المجاني بس) → الدعم الفني بس
//
// السبب إن التيم العلمي أربع أنفار، والمنصة عليها ٤٠٢٢ طالب في الكورس المجاني. الدعم
// الفني مفتوح للكل لأن أعطال المنصة بتحصل لأي حد. تعريف «مشترك» في
// `utils/studentAccess.js`، ومكتوب مرة واحدة عشان الزرار اللي بيبان يبقى هو الزرار
// اللي بيشتغل.
//
// **دي مش قايمة أوامر البوت (الزرار الأزرق)** — دي `reply keyboard` بتتبعت مع الرسالة نفسها.
// القايمة الزرقا لسه فاضية بطلب صاحب المشروع (شوف `botManager.js`)، والاتنين مالهمش علاقة
// ببعض خالص.
//
// **ليه بتتبعت مع كل رسالة آلية بدل مرة واحدة عند `/start`:** الكيبورد بيوصل الطالب مع رسالة،
// مافيش طريقة تبعته لوحده. ولو حطّيناه في `/start` بس، الـ ١٨٠٠ طالب اللي دخلوا البوت قبل
// النهاردة عمرهم ما هيشوفوه. تيليجرام بيستبدل الكيبورد القديم بالجديد ومابيكرّرش حاجة، فإرساله
// مع كل رد آلي مالوش أي تكلفة ظاهرة عند الطالب. **وده كمان اللي بيحدّث القايمة لوحدها** لما
// الطالب يشترك: أول رد آلي بعد الاشتراك بيوصله بالزراير التلاتة.
//
// **تيم المتابعة هو الافتراضي**: الطالب الجديد تذكرته مع المتابعة من غير ما يضغط حاجة، والزرار
// ده معناه "رجّعني للمتابعة" لو كان محوّل لتيم متخصص.
const pool = require('../config/db');
const { isSubscribedStudent } = require('../utils/studentAccess');

const SCIENCE_BUTTON = '🧪 الدعم العلمي';
const TECH_BUTTON = '🛠️ الدعم الفني';
const FOLLOWUP_BUTTON = '👥 تيم المتابعة';

const STUDENT_MENU = {
  keyboard: [
    [{ text: SCIENCE_BUTTON }, { text: TECH_BUTTON }],
    [{ text: FOLLOWUP_BUTTON }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// غير المشترك: زرار واحد. **مش نفس القايمة والزراير مخفية** — تيليجرام مابيخفيش زرار،
// فالقايمة المحدودة لازم تكون قايمة تانية بالكامل
const TECH_ONLY_MENU = {
  keyboard: [
    [{ text: TECH_BUTTON }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

async function menuFor(chatId) {
  return (await isSubscribedStudent(chatId)) ? STUDENT_MENU : TECH_ONLY_MENU;
}

// ---------- الكيبورد بيتبعت لما يتغيّر بس ----------
//
// **تيليجرام مابيسمحش بتعديل رسالة اتبعتت ومعاها reply keyboard** — بيرد
// `message can't be edited`. والكيبورد كان بيتبعت مع كل رسالة، فمن ٥ سبتمبر ٢٠٢٦ بقى
// مفيش ولا رد موظف قابل للتعديل: ٤١٠ تعديل ناجح كلهم قبل التاريخ ده، وصفر بعده.
//
// والكيبورد مالوش لازمة يتكرر أصلًا: `is_persistent: true` معناه إنه بيفضل تحت مربع
// الكتابة لحد ما كيبورد تاني يحل محله. فبنبعته أول مرة، وبعدها بس لما يتغيّر (الطالب
// اشترك مثلًا) — والرسايل اللي بينهم تفضل قابلة للتعديل.
async function rememberedKind(chatId) {
  try {
    const { rows } = await pool.query('SELECT student_menu_kind FROM contacts WHERE chat_id = $1', [chatId]);
    return rows[0]?.student_menu_kind || null;
  } catch (error) {
    console.error(`❌ Failed to read the student menu state of chat ${chatId}:`, error.message);
    // الفشل هنا بيخلي الكيبورد يتبعت زي الأول — أسوأ حاجة إن الرسالة دي متتعدلش
    return null;
  }
}

async function rememberKind(chatId, kind) {
  try {
    await pool.query('UPDATE contacts SET student_menu_kind = $2 WHERE chat_id = $1', [chatId, kind]);
  } catch (error) {
    console.error(`❌ Failed to store the student menu state of chat ${chatId}:`, error.message);
  }
}

// بترجّع الكيبورد لو الطالب لسه ماشافوش أو اتغيّر، و`null` لو هو نفسه اللي عنده
async function menuIfChanged(chatId) {
  const keyboard = await menuFor(chatId);
  const kind = keyboard === STUDENT_MENU ? 'full' : 'tech';
  if ((await rememberedKind(chatId)) === kind) return null;
  await rememberKind(chatId, kind);
  return keyboard;
}

// أغلب مواضع الإرسال بتبعت خيارات تانية (رد على رسالة، caption...)، فالدمج بيحصل هنا في مكان
// واحد بدل ما كل موضع يفتكر يحط `reply_markup` جنب خياراته.
//
// **دي بتبعت الكيبورد لو اتغيّر بس.** الرسالة اللي مامعاهاش كيبورد بتفضل قابلة للتعديل،
// وده اللي بيخلي الموظف يقدر يصلّح كلامه
async function withStudentMenu(chatId, options = {}) {
  const keyboard = await menuIfChanged(chatId);
  return keyboard ? { ...options, reply_markup: keyboard } : { ...options };
}

async function studentMenuOptions(chatId) {
  const keyboard = await menuIfChanged(chatId);
  return keyboard ? { reply_markup: keyboard } : {};
}

// **بتبعت الكيبورد دايمًا**، للمواضع اللي الطالب لازم يشوفه فيها مهما حصل: `/start`
// ورسالة الترحيب. دي رسايل محدش بيعدّلها، فالتنازل هنا مالوش تكلفة
async function studentMenuOptionsAlways(chatId) {
  const keyboard = await menuFor(chatId);
  await rememberKind(chatId, keyboard === STUDENT_MENU ? 'full' : 'tech');
  return { reply_markup: keyboard };
}

module.exports = {
  SCIENCE_BUTTON,
  TECH_BUTTON,
  FOLLOWUP_BUTTON,
  STUDENT_MENU,
  TECH_ONLY_MENU,
  menuFor,
  menuIfChanged,
  studentMenuOptions,
  studentMenuOptionsAlways,
  withStudentMenu,
};
