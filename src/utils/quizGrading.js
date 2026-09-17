const pool = require('../config/db');
const { callProvider, PROVIDERS, listProviders } = require('./aiProviders');
const {
  GRADE_FIELDS, GRADE_TOOL, GRADE_JSON_SHAPE, buildSystemPrompt, buildUserText, normalizeGrade,
} = require('./quizGradingRules');

// ---------- تصحيح المقالي عن طريق الـAPI ----------
//
// **القواعد نفسها مش هنا** — هي في `quizGradingRules.js` عشان أداة التصحيح المحلي
// (`tools/local-grader`) تقرا نفس المعيار بالظبط. الملف ده مسؤول عن حاجة واحدة:
// اختيار المزوّد ونداءه وتطبيع اللي رجع.

const DEFAULT_PROVIDER = 'anthropic';

// نموذج التصحيح منفصل عن نموذج الرد الآلي: الرد بيتكلم مع طالب، والتصحيح بيحط درجة.
// لو المفتاح فاضي أو فيه مزوّد اتشال من الكود، بنرجع لمزوّد الرد الآلي وبعده للافتراضي —
// **مابنرميش خطأ**: إعداد غلط في صف settings مايوقفش تصحيح ورقة طالب
async function activeProvider() {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('quiz_grading_provider', 'ai_provider')");
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const chosen = settings.quiz_grading_provider;
  if (chosen && PROVIDERS[chosen]) return chosen;
  return settings.ai_provider && PROVIDERS[settings.ai_provider] ? settings.ai_provider : DEFAULT_PROVIDER;
}

function isEnabled() {
  return listProviders().some((p) => p.available);
}

// بترجع الحكم بس — الحفظ وحساب الدرجة عند اللي بينده. نفس فصل المسؤوليات في generateReply
// `answerImage` = { media_type, data } لما الطالب يرفع إجابته مصوّرة بدل ما يكتبها.
// بتحل محل النص مش بتتضاف ليه — إجابة واحدة لكل سؤال، فالنموذج بيحكم على مصدر واحد
async function gradeEssayAnswer({ question, referenceAnswer, gradingNotes, studentAnswer, provider, answerImage = null }) {
  const providerKey = provider || (await activeProvider());
  const systemPrompt = buildSystemPrompt(question, referenceAnswer, gradingNotes);
  const userText = buildUserText({ studentAnswer, hasImage: Boolean(answerImage) });
  const { output, usage } = await callProvider(providerKey, {
    systemPrompt,
    question: userText,
    image: answerImage,
    tool: GRADE_TOOL,
    jsonShape: GRADE_JSON_SHAPE,
    maxTokens: 512,
  });
  const grade = normalizeGrade(output);
  if (!grade) throw new Error('النموذج رجّع حكم غير مفهوم');
  // الاستهلاك بيترجع مع الحكم عشان اللي بيحفظ الدرجة يحفظه معاها في نفس الصف — من غير
  // كده التكلفة بتتقدّر بدل ما تتقاس
  return { ...grade, provider: providerKey, model: PROVIDERS[providerKey]?.model || null, usage: usage || null };
}

module.exports = { gradeEssayAnswer, isEnabled, GRADE_FIELDS };
