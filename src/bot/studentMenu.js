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

// أغلب مواضع الإرسال بتبعت خيارات تانية (رد على رسالة، caption...)، فالدمج بيحصل هنا في مكان
// واحد بدل ما كل موضع يفتكر يحط `reply_markup` جنب خياراته
async function withStudentMenu(chatId, options = {}) {
  return { ...options, reply_markup: await menuFor(chatId) };
}

// اختصار للموضع اللي مابيبعتش خيارات تانية — وهو الأغلب
async function studentMenuOptions(chatId) {
  return { reply_markup: await menuFor(chatId) };
}

module.exports = {
  SCIENCE_BUTTON,
  TECH_BUTTON,
  FOLLOWUP_BUTTON,
  STUDENT_MENU,
  TECH_ONLY_MENU,
  menuFor,
  studentMenuOptions,
  withStudentMenu,
};
