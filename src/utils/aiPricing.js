// ---------- تسعير نداءات النموذج ----------
//
// **ليه الملف ده موجود:** المشروع كان بيسجّل التوكنز ومابيحسبش تكلفتها، فالسؤال «الاختبار
// ده كلّف كام؟» مكانش ليه إجابة غير التخمين. والتخمين هنا **بيفرق أضعاف** — اتحسبت تكلفة
// تصحيح ورقة بالصور يوم ١٥ سبتمبر ٢٠٢٦ من غير حساب الكاش وطلعت $0.29، والحقيقة $0.11.
//
// **الكاش هو الفرق كله.** البرومبت الثابت (~١٧٨٠ توكن) بيتبعت مع كل سؤال وهو نفسه بالحرف
// لكل طلاب السؤال الواحد، فأول طالب بيكتبه بمرة وربع السعر والباقي بيقروه **بعُشر** السعر.
// حساب التكلفة من `input_tokens` لوحده بيضخّم الرقم أضعاف.
//
// ⚠️ **الأسعار دي بتتغير من المزوّد.** لو حسّيت إن الأرقام المعروضة بقت غلط، أول حاجة
// تتراجع هي الجدول ده مقابل صفحة التسعير الرسمية — مش الكود اللي بيحسب.
// آخر مراجعة: ١٥ سبتمبر ٢٠٢٦.

// $ لكل مليون توكن
const PRICING = {
  'claude-opus-5': { input: 5.00, output: 25.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00 },
  'claude-sonnet-5': { input: 2.00, output: 10.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  // Groq مجاني على الخطة الحالية — بيتسجّل بصفر مش بـnull عشان المجموع يفضل رقم
  'openai/gpt-oss-120b': { input: 0, output: 0 },
};

// قراءة الكاش بعُشر سعر الدخل، وكتابته بمرة وربع. النسب دي ثابتة عند المزوّد ومش بتختلف
// من نموذج للتاني، فمحسوبة مش مكتوبة لكل صف
const CACHE_READ_RATE = 0.10;
const CACHE_WRITE_RATE = 1.25;

// نموذج مش في الجدول: بنرجّع صفر بدل ما نرمي. عرض «$0.00» غلط، بس إيقاف صفحة النتايج
// كلها عشان نموذج جديد اتضاف أغلط — والصفر بيبان شاذ وسط الأرقام فبيتلاحظ
function ratesFor(model) {
  return PRICING[model] || { input: 0, output: 0 };
}

// بترجّع التكلفة بالدولار لنداء واحد. كل الحقول اختيارية — الصف القديم اللي اتسجّل قبل
// ما التوكنز تتحفظ بيرجّع صفر، وده صحيح: إحنا فعلًا مش عارفين كلّف كام
function callCost({ model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens } = {}) {
  const rate = ratesFor(model);
  const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return (
    (n(input_tokens) * rate.input
      + n(output_tokens) * rate.output
      + n(cache_read_tokens) * rate.input * CACHE_READ_RATE
      + n(cache_write_tokens) * rate.input * CACHE_WRITE_RATE)
    / 1e6
  );
}

// **SQL مش JS** عشان المجاميع تتحسب في القاعدة. جمع تكلفة ٥٠٠ ورقة في الكنترولر معناه
// جلب كل صفوف الإجابات للذاكرة — والتعبير ده بيخلي `SUM()` تشتغل على الصف مباشرة.
//
// `alias` هو اسم جدول الإجابات في الاستعلام (`an` عادةً)، و`modelColumn` العمود اللي
// فيه اسم النموذج
function costSql(alias = 'an', modelColumn = 'ai_model') {
  const cases = Object.entries(PRICING)
    .map(([model, rate]) => `WHEN ${alias}.${modelColumn} = '${model}' THEN `
      + `(COALESCE(${alias}.input_tokens,0) * ${rate.input}`
      + ` + COALESCE(${alias}.output_tokens,0) * ${rate.output}`
      + ` + COALESCE(${alias}.cache_read_tokens,0) * ${rate.input * CACHE_READ_RATE}`
      + ` + COALESCE(${alias}.cache_write_tokens,0) * ${rate.input * CACHE_WRITE_RATE}) / 1000000.0`)
    .join('\n      ');
  return `CASE\n      ${cases}\n      ELSE 0 END`;
}

// للعرض: الأرقام هنا صغيرة جدًا (سنت وأجزاء منه)، و`toFixed(2)` بيحوّل كل حاجة لـ$0.00
function formatCost(dollars) {
  const value = Number(dollars) || 0;
  if (value === 0) return '—';
  if (value < 0.01) return `${(value * 100).toFixed(2)}¢`;
  return `$${value.toFixed(2)}`;
}

module.exports = { PRICING, callCost, costSql, formatCost, ratesFor };
