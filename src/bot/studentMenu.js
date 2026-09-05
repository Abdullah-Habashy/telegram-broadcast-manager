// ---------- قايمة الطالب الثابتة تحت مربع الكتابة ----------
//
// تلات زراير بيشوفهم **كل** طالب: الدعم العلمي، الدعم الفني، وتيم المتابعة.
//
// **دي مش قايمة أوامر البوت (الزرار الأزرق)** — دي `reply keyboard` بتتبعت مع الرسالة نفسها.
// القايمة الزرقا لسه فاضية بطلب صاحب المشروع (شوف `botManager.js`)، والاتنين مالهمش علاقة
// ببعض خالص.
//
// **ليه بتتبعت مع كل رسالة آلية بدل مرة واحدة عند `/start`:** الكيبورد بيوصل الطالب مع رسالة،
// مافيش طريقة تبعته لوحده. ولو حطّيناه في `/start` بس، الـ ١٨٠٠ طالب اللي دخلوا البوت قبل
// النهاردة عمرهم ما هيشوفوه. تيليجرام بيستبدل الكيبورد القديم بالجديد ومابيكرّرش حاجة، فإرساله
// مع كل رد آلي مالوش أي تكلفة ظاهرة عند الطالب.
//
// **تيم المتابعة هو الافتراضي**: الطالب الجديد تذكرته مع المتابعة من غير ما يضغط حاجة، والزرار
// ده معناه "رجّعني للمتابعة" لو كان محوّل لتيم متخصص.
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

// أغلب مواضع الإرسال بتبعت خيارات تانية (رد على رسالة، caption...)، فالدمج بيحصل هنا في مكان
// واحد بدل ما كل موضع يفتكر يحط `reply_markup` جنب خياراته
function withStudentMenu(options = {}) {
  return { ...options, reply_markup: STUDENT_MENU };
}

module.exports = {
  SCIENCE_BUTTON,
  TECH_BUTTON,
  FOLLOWUP_BUTTON,
  STUDENT_MENU,
  STUDENT_MENU_OPTIONS: { reply_markup: STUDENT_MENU },
  withStudentMenu,
};
