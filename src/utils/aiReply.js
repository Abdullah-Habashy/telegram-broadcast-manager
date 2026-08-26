const pool = require('../config/db');
const { callProvider, listProviders, PROVIDERS } = require('./aiProviders');

// ---------- الرد الآلي المقيّد بقاعدة المعرفة ----------
//
// **مش تدريب.** محتوى ai_knowledge بيتبعت للنموذج مع كل سؤال كسياق، والنموذج ممنوع يجاوب من
// برّه. يعني تعديل أي صف في الجدول بيطبّق في نفس اللحظة — من غير إعادة تدريب ولا نشر.
//
// المزوّد قابل للتبديل (Claude مدفوع / Llama على Groq مجاني) لأن السؤال "المجاني يكفي ولا لأ"
// مالوش إجابة نظرية — بيتقاس بتشغيل نفس الأسئلة على الاتنين. آلية المقارنة في compareProviders

const DEFAULT_PROVIDER = 'anthropic';

function buildSystemPrompt(knowledge, blockedTopics) {
  const source = knowledge
    .map((row, index) => `[${index + 1}] س: ${row.question}\n    ج: ${row.answer}`)
    .join('\n\n');

  return `إنت بترد على طلاب منصة تعليمية على تليجرام، بالعامية المصرية.

المصدر الوحيد المسموح لك تجاوب منه:
${source}

القواعد، بالترتيب ده:

١. **متجاوبش من أي حاجة برّه المصدر ده.** لو الإجابة مش موجودة فيه صراحةً، حط
   found_in_source = false. ده مش فشل — ده التصرف الصح، والسؤال هيروح لموظف بشري.
   متستنتجش، متخمّنش، ومتكمّلش معلومة ناقصة من معرفتك العامة.

٢. **أي سؤال بيمس المواضيع دي حط فيه blocked_topic = true** حتى لو الإجابة في المصدر:
   ${blockedTopics}

٣. لو الإجابة موجودة: اكتبها بالعامية المصرية، **جملتين على الأكثر**، من غير مقدمات
   ("أهلًا بيك"، "شكرًا لسؤالك") — الطالب عايز الإجابة مش ترحيب.

٤. متوعدش بأي حاجة، ومتحددش مواعيد، ومتقولش أرقام مش مكتوبة في المصدر حرفيًا.

٥. لو الطالب بيشتكي أو مضايق أو بيتكلم عن حاجة شخصية — found_in_source = false مهما كان.`;
}

async function loadContext() {
  const [knowledge, settings] = await Promise.all([
    pool.query('SELECT question, answer FROM ai_knowledge WHERE is_active ORDER BY id'),
    pool.query(`SELECT key, value FROM settings WHERE key IN
      ('ai_reply_enabled', 'ai_reply_prefix', 'ai_blocked_topics', 'ai_provider')`),
  ]);
  return {
    knowledge: knowledge.rows,
    settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])),
  };
}

// أي مزوّد متاح أصلًا؟ الميزة بتتعطّل لوحدها لو مفيش ولا مفتاح مضبوط
function isEnabled() {
  return listProviders().some((p) => p.available);
}

// بترجع { outcome, answer, ... } — والمنادي هو اللي بيبعت فعلًا. الفصل مقصود: الدالة دي
// مسؤولة عن "إيه الرد الصح" بس، والإرسال والتسجيل عند اللي بينده
async function generateReply({ question, provider, skipEnabledCheck = false }) {
  const { knowledge, settings } = await loadContext();
  const providerKey = provider || settings.ai_provider || DEFAULT_PROVIDER;

  // التجربة من اللوحة بتتخطى شرط التشغيل: الأدمن لازم يقدر يجرّب قبل ما يشغّل
  if (!skipEnabledCheck && settings.ai_reply_enabled !== 'true') {
    return { outcome: 'error', detail: 'الرد الآلي مقفول', provider: providerKey };
  }
  if (!knowledge.length) return { outcome: 'error', detail: 'قاعدة المعرفة فاضية', provider: providerKey };

  const systemPrompt = buildSystemPrompt(knowledge, settings.ai_blocked_topics || 'لا يوجد');
  const startedAt = Date.now();
  const { output, usage } = await callProvider(providerKey, { systemPrompt, question });
  const base = {
    provider: providerKey,
    model: PROVIDERS[providerKey]?.model || null,
    latency_ms: Date.now() - startedAt,
    ...usage,
  };

  if (output.blocked_topic) return { outcome: 'blocked', detail: 'موضوع ممنوع', ...base };
  if (!output.found_in_source || !output.answer.trim()) return { outcome: 'no_answer', ...base };

  const prefix = settings.ai_reply_prefix ? `${settings.ai_reply_prefix}\n\n` : '';
  return { outcome: 'sent', answer: `${prefix}${output.answer.trim()}`, ...base };
}

// بيشغّل نفس السؤال على كل مزوّد متاح عشان المقارنة تبقى على نفس المدخل بالظبط.
// الأسئلة اللي **مش** في المصدر هي أهم اختبار: النموذج الضعيف بيحب "يساعد" فيخترع إجابة،
// والفرق بين المزوّدين بيبان هناك مش في الأسئلة السهلة
async function compareProviders({ question }) {
  const available = listProviders().filter((p) => p.available);
  const results = await Promise.all(available.map(async (p) => {
    try {
      return await generateReply({ question, provider: p.key, skipEnabledCheck: true });
    } catch (error) {
      return { outcome: 'error', detail: error.message, provider: p.key, model: p.model };
    }
  }));
  return { question, results };
}

async function logAttempt({ ticketId, incomingMessageId, question, result }) {
  await pool.query(
    `INSERT INTO ai_reply_log
       (ticket_id, incoming_message_id, question, answer, outcome, detail,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [ticketId, incomingMessageId, question, result.answer || null, result.outcome,
      result.detail || null, result.input_tokens ?? null, result.output_tokens ?? null,
      result.cache_read_tokens ?? null, result.cache_write_tokens ?? null, result.provider || null]
  );
}

module.exports = { generateReply, compareProviders, logAttempt, isEnabled, listProviders };
