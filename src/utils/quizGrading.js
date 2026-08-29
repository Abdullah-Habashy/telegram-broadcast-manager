const pool = require('../config/db');
const { callProvider, PROVIDERS, listProviders } = require('./aiProviders');

// ---------- تصحيح الأسئلة المقالية ----------
//
// **المعيار هو المعنى، مش النص.** الطالب بيكتب من موبايله وبسرعة: بيغلط إملائيًا، بيكتب
// "التمثيل الضوئي" و"البناء الضوئي"، بيبدأ بـ"يعني" و"هو ان"، وبيرتّب الكلام غير المرجع.
// المقارنة الحرفية أو نسبة التشابه بتسقّط الإجابات دي كلها وهي صح — وده بالظبط اللي خلّى
// التصحيح الآلي مش مستخدم في المدارس. النموذج بيقرا المعنى، فالقاعدة الوحيدة اللي بنفرضها
// عليه هي إنه **مايحاسبش على أي حاجة غير المعنى**.
//
// الإجابة المرجعية بتتبعت مع كل سؤال كسياق — زي ai_knowledge بالظبط. يعني الموظف يعدّل
// المرجع النهارده والتصحيح يتغيّر في نفس اللحظة، من غير تدريب ولا نشر.

const DEFAULT_PROVIDER = 'anthropic';

// نفس منطق OUTPUT_FIELDS في aiProviders: كل قرار حقل مستقل نقدر نتحقق منه، مش استنتاج من
// نص السبب. verdict و score_ratio منفصلين عن بعض عشان الموظف يشوف حكم النموذج والدرجة
// اللي طلعت منه مع بعض ويعرف لو الاتنين اتخالفوا
const GRADE_FIELDS = {
  verdict: 'correct لو إجابة الطالب توصّل نفس معنى الإجابة المرجعية. partial لو وصّلت جزء منه بس. incorrect لو مختلفة أو فاضية أو مالهاش علاقة.',
  score_ratio: 'نسبة من 0 إلى 1 من درجة السؤال. correct = 1، incorrect = 0، partial = النسبة اللي وصّلها فعلًا.',
  reason: 'سبب مختصر بالعامية المصرية في جملة واحدة، موجّه للموظف مش للطالب. اذكر إيه اللي ناقص لو partial أو incorrect.',
};

const GRADE_TOOL = {
  name: 'grade_essay_answer',
  description: 'صحّح إجابة الطالب المقالية بمقارنة معناها بالإجابة المرجعية.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['correct', 'partial', 'incorrect'], description: GRADE_FIELDS.verdict },
      score_ratio: { type: 'number', description: GRADE_FIELDS.score_ratio },
      reason: { type: 'string', description: GRADE_FIELDS.reason },
    },
    required: ['verdict', 'score_ratio', 'reason'],
  },
};

const GRADE_JSON_SHAPE = '{"verdict": "correct" أو "partial" أو "incorrect", "score_ratio": رقم من 0 لـ 1, "reason": "..."}';

function buildSystemPrompt(question, referenceAnswer, gradingNotes) {
  return `إنت مصحّح امتحانات. مهمتك تقارن إجابة الطالب بالإجابة المرجعية وتحكم على **المعنى**.

السؤال:
${question}

الإجابة المرجعية (دي الحقيقة الوحيدة — أي معلومة مش فيها متحاسبش عليها الطالب لا بالسلب ولا بالإيجاب):
${referenceAnswer}

القواعد، بالترتيب ده:

١. **الأخطاء الإملائية مش غلط.** "الاكسجين"، "الأكسچين"، "اوكسجين" — كلها نفس الكلمة.
   نفس الكلام على الهمزات والتاء المربوطة والمسافات وعلامات الترقيم.

٢. **اختلاف الصياغة مش غلط.** الطالب ممكن يكتب بالعامية، أو يقلب ترتيب الجمل، أو يستخدم
   مرادف، أو يشرح بأسلوبه، أو يكتب أطول أو أقصر من المرجع بكتير. طالما المعنى واصل،
   الإجابة صح. **المقارنة بالمعنى مش بالألفاظ.**

٣. **الإنجليزي والعربي سواء.** لو المرجع بالعربي والطالب كتب نفس المعنى بالإنجليزي (أو
   العكس، أو مخلوط) — صح.

٤. غلط بس لو **المعنى نفسه** ناقص أو مختلف أو متناقض مع المرجع. لو المرجع فيه أكتر من
   عنصر والطالب ذكر بعضهم بس، حط partial وحدّد score_ratio بنسبة اللي ذكره فعلًا.

٥. **إجابة فاضية أو كلام مالهوش علاقة بالسؤال = incorrect و score_ratio = 0**، حتى لو
   الكلام في نفسه صح.

٦. متزوّدش من عندك. لو الطالب كتب حاجة صح علميًا بس مش مطلوبة في السؤال، دي مابتزوّدش
   درجته ومابتنقّصهاش.

٧. **متحاسبش على الطول.** إجابة من كلمتين توصّل المعنى = correct زي إجابة من عشر سطور.
${gradingNotes ? `
تعليمات إضافية من الموظف للسؤال ده بالذات:
${gradingNotes}

التعليمات دي بتضيف شرط على المعنى المطلوب — **مابتلغيش القواعد الأولى والتانية والتالتة**:
الإملاء والصياغة واللغة تفضل مش محسوبة عليه مهما كانت التعليمات.` : ''}`;
}

// أي مخرج مش مطابق بيتعامل على إنه فشل صريح مش صفر — الفرق مهم: الصفر بيتحسب في درجة
// الطالب، والفشل بيتعلّم عشان الموظف يصحّح السؤال ده بإيده
function normalizeGrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = ['correct', 'partial', 'incorrect'].includes(raw.verdict) ? raw.verdict : null;
  if (!verdict) return null;
  let ratio = Number(raw.score_ratio);
  if (!Number.isFinite(ratio)) ratio = verdict === 'correct' ? 1 : 0;
  // النموذج ساعات بيقول correct وبيحط 0.9، أو incorrect وبيحط 0.2. الحكم هو اللي بيكسب
  // في الطرفين — الدرجة الجزئية ليها معنى في partial بس
  if (verdict === 'correct') ratio = 1;
  if (verdict === 'incorrect') ratio = 0;
  return {
    verdict,
    score_ratio: Math.max(0, Math.min(1, ratio)),
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
  };
}

async function activeProvider() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'ai_provider'");
  return rows[0]?.value || DEFAULT_PROVIDER;
}

function isEnabled() {
  return listProviders().some((p) => p.available);
}

// بترجع الحكم بس — الحفظ وحساب الدرجة عند اللي بينده. نفس فصل المسؤوليات في generateReply
async function gradeEssayAnswer({ question, referenceAnswer, gradingNotes, studentAnswer, provider }) {
  const providerKey = provider || (await activeProvider());
  const systemPrompt = buildSystemPrompt(question, referenceAnswer, gradingNotes);
  const { output } = await callProvider(providerKey, {
    systemPrompt,
    question: `إجابة الطالب:\n${studentAnswer}`,
    tool: GRADE_TOOL,
    jsonShape: GRADE_JSON_SHAPE,
    maxTokens: 512,
  });
  const grade = normalizeGrade(output);
  if (!grade) throw new Error('النموذج رجّع حكم غير مفهوم');
  return { ...grade, provider: providerKey, model: PROVIDERS[providerKey]?.model || null };
}

module.exports = { gradeEssayAnswer, isEnabled, GRADE_FIELDS };
