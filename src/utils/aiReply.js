const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../config/db');
const env = require('../config/env');

// ---------- الرد الآلي المقيّد بقاعدة المعرفة ----------
//
// **مش تدريب.** محتوى ai_knowledge بيتبعت للنموذج مع كل سؤال كسياق، والنموذج ممنوع يجاوب من
// برّه. يعني تعديل أي صف في الجدول بيطبّق في نفس اللحظة — من غير إعادة تدريب ولا نشر.
//
// النموذج له مخرجان بس: يجاوب من المصدر، أو يقول إنه مش لاقي — ومفيش حالة تالتة. الإجابة
// بتترجع في حقل منفصل عن قرار "لقيت ولا لأ" عشان القرار ده يبقى صريح ونقدر نتحقق منه، بدل ما
// نحاول نستنتجه من نص الرد
const MODEL = 'claude-opus-5';

// الرد على طالب في شات لازم يبقى قصير. الحد ده سقف أمان مش هدف — التعليمات بتطلب الاختصار
const MAX_TOKENS = 1024;

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

function isEnabled() {
  return Boolean(client);
}

// الأداة هي وسيلة الإجبار على مخرج منظّم: النموذج لازم ينده بيها، فبناخد قراره كحقل منطقي
// مش كنص نحاول نفسّره. strict بيضمن إن المدخلات مطابقة للمخطط بالظبط
const ANSWER_TOOL = {
  name: 'reply_to_student',
  description: 'سجّل نتيجة محاولة الإجابة على سؤال الطالب من المصدر المسموح.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      found_in_source: {
        type: 'boolean',
        description: 'true لو الإجابة موجودة صراحةً في المصدر المرفق. false لو مش موجودة أو مش أكيدة.',
      },
      blocked_topic: {
        type: 'boolean',
        description: 'true لو السؤال بيمس أي موضوع من المواضيع الممنوعة.',
      },
      answer: {
        type: 'string',
        description: 'الرد للطالب بالعامية المصرية، جملتين على الأكثر. فاضي لو found_in_source = false أو blocked_topic = true.',
      },
    },
    required: ['found_in_source', 'blocked_topic', 'answer'],
  },
};

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

٥. لو الطالب بيشتكي أو مضايق أو بيتكلم عن حاجة شخصية — found_in_source = false مهما كان.

ندِه بأداة reply_to_student دايمًا.`;
}

async function loadContext() {
  const [knowledge, settings] = await Promise.all([
    pool.query('SELECT question, answer FROM ai_knowledge WHERE is_active ORDER BY id'),
    pool.query("SELECT key, value FROM settings WHERE key IN ('ai_reply_enabled', 'ai_reply_prefix', 'ai_blocked_topics')"),
  ]);
  return {
    knowledge: knowledge.rows,
    settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])),
  };
}

// بترجع { sent, answer, outcome, detail } — والمنادي هو اللي بيبعت فعلًا.
// الفصل ده مقصود: الدالة دي مسؤولة عن "إيه الرد الصح" بس، والإرسال والتسجيل عند اللي بينده
async function generateReply({ question }) {
  if (!client) return { outcome: 'error', detail: 'ANTHROPIC_API_KEY مش مضبوط' };

  const { knowledge, settings } = await loadContext();
  if (settings.ai_reply_enabled !== 'true') return { outcome: 'error', detail: 'الرد الآلي مقفول' };
  if (!knowledge.length) return { outcome: 'error', detail: 'قاعدة المعرفة فاضية' };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // effort منخفض عن قصد: دي مهمة استخراج من نص قصير مش مسألة تحتاج تفكير عميق،
    // والرد على طالب مستني لازم يكون سريع
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: buildSystemPrompt(knowledge, settings.ai_blocked_topics || 'لا يوجد') }],
    tools: [ANSWER_TOOL],
    tool_choice: { type: 'tool', name: ANSWER_TOOL.name },
    messages: [{ role: 'user', content: question }],
  });

  const usage = {
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
  };

  // النموذج ممكن يرفض الطلب نفسه لأسباب أمان — ساعتها مفيش نداء أداة، والسؤال بيروح لموظف
  if (response.stop_reason === 'refusal') {
    return { outcome: 'blocked', detail: 'النموذج رفض الطلب', ...usage };
  }
  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) return { outcome: 'error', detail: 'النموذج مانداش بالأداة', ...usage };

  const { found_in_source: found, blocked_topic: blocked, answer } = toolUse.input;
  if (blocked) return { outcome: 'blocked', detail: 'موضوع ممنوع', ...usage };
  if (!found || !String(answer || '').trim()) return { outcome: 'no_answer', ...usage };

  return {
    outcome: 'sent',
    answer: `${settings.ai_reply_prefix ? settings.ai_reply_prefix + '\n\n' : ''}${answer.trim()}`,
    ...usage,
  };
}

async function logAttempt({ ticketId, incomingMessageId, question, result }) {
  await pool.query(
    `INSERT INTO ai_reply_log
       (ticket_id, incoming_message_id, question, answer, outcome, detail, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ticketId, incomingMessageId, question, result.answer || null, result.outcome,
      result.detail || null, result.input_tokens ?? null, result.output_tokens ?? null]
  );
}

module.exports = { generateReply, logAttempt, isEnabled, MODEL };
