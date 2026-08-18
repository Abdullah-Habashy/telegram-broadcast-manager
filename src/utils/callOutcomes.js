// تصنيف نتايج المكالمات — مصدر واحد للحقيقة لكل الشاشات.
//
// "معرفناش نوصله" = محاولة اتعملت والطالب مردّش. دي اللي بتكوّن سلسلة عدم الوصول في فلتر
// "محاولات متتالية"، وهي نفسها اللي بتطلع بره نسبة نجاح المكالمات في متابعة الأداء.
//
// "رقم غير صحيح" **مش** منهم عن قصد: دي مشكلة في بيانات الطالب مش محاولة اتصال فاشلة — إعادة
// الاتصال بنفس الرقم مش هتنفع مهما اتكررت، فبتتحسب على حدة عشان تبان كمشكلة بيانات محتاجة تصحيح.
//
// الأسماء دي هي المزروعة في schema.sql. الأدمن يقدر يضيف نتايج جديدة من اللوحة، وأي نتيجة
// مضافة بتتحسب افتراضيًا "وصلنا له" — وده الافتراض الأسلم، لأن النتايج المضافة يدويًا بتكون
// غالبًا وصف لمكالمة تمّت فعلًا (مهتم / مش مهتم / هيفكر...).
const UNREACHED_OUTCOME_NAMES = ['لم يرد', 'الخط مشغول'];
const INVALID_NUMBER_OUTCOME_NAME = 'رقم غير صحيح';

// نفس القيم كـ literal جاهز للاستخدام جوه استعلامات SQL (IN / NOT IN)
const UNREACHED_NAMES_SQL = `(${UNREACHED_OUTCOME_NAMES.map((name) => `'${name}'`).join(', ')})`;
const INVALID_NUMBER_SQL = `'${INVALID_NUMBER_OUTCOME_NAME}'`;

// شرط "المكالمة دي وصلنا فيها للطالب" — بيفترض alias باسم co لجدول call_outcomes.
// المكالمة من غير نتيجة مسجّلة مابتتحسبش وصول، لأننا ببساطة مش عارفين حصل فيها إيه
const REACHED_CONDITION_SQL = `(co.name IS NOT NULL AND co.name NOT IN ${UNREACHED_NAMES_SQL} AND co.name <> ${INVALID_NUMBER_SQL})`;

module.exports = {
  UNREACHED_OUTCOME_NAMES,
  INVALID_NUMBER_OUTCOME_NAME,
  UNREACHED_NAMES_SQL,
  INVALID_NUMBER_SQL,
  REACHED_CONDITION_SQL,
};
