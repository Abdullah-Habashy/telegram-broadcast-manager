const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');

// ---------- مزوّدو النماذج ----------
//
// الاتنين بيتحطّ عليهم نفس السؤال ونفس المصدر ونفس القواعد، ولازم يرجّعوا نفس التلات حقول:
// لقى الإجابة؟ الموضوع ممنوع؟ والرد نفسه. الاختلاف في طريقة الإجبار على المخرج بس.
//
// السبب في وجود الاتنين: النماذج المفتوحة مجانية على Groq، لكن المهمة هنا مش "جاوب" —
// المهمة "متجاوبش لو الإجابة مش في المصدر". دي أصعب حاجة على النماذج الأصغر لأنها بتحب
// "تساعد" فبتكمّل من معرفتها العامة. المقارنة الفعلية على أسئلة حقيقية هي الطريقة الوحيدة
// للحكم — عشان كده الاتنين متاحين والتجربة بتشغّلهم مع بعض.

const anthropicClient = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

const PROVIDERS = {
  anthropic: {
    key: 'anthropic',
    label: 'Claude Opus 5 — الأدق',
    model: 'claude-opus-5',
    // Opus بيقبل output_config.effort، وHaiku بيرد 400 عليه — الفرق ده لازم يبقى خاصية
    // على المزوّد مش شرط مدفون جوه دالة النداء
    supportsEffort: true,
    available: () => Boolean(anthropicClient),
  },
  // نفس المزوّد بنموذج أخف. اتقاس على نفس التمن أسئلة: ٨/٨ زي Opus، وضعف السرعة (٢.٤ث
  // مقابل ٥ث) وخُمس التكلفة. الفرق بيبان لما قاعدة المعرفة تكبر والتمييز بين المعلومات
  // المتشابهة يصعب — فالاتنين متاحين والمقارنة في اللوحة هي اللي بتحكم
  anthropic_haiku: {
    key: 'anthropic_haiku',
    label: 'Claude Haiku 4.5 — أسرع وأرخص',
    model: 'claude-haiku-4-5',
    supportsEffort: false,
    available: () => Boolean(anthropicClient),
  },
  groq: {
    key: 'groq',
    label: 'GPT-OSS 120B (Groq — مجاني)',
    // اتختار بعد اختبار فعلي على ٧ أسئلة (إجابات في المصدر، إجابات مش فيه، ومواضيع ممنوعة)
    // ضد qwen3.6-27b و allam-2-7b. التلاتة نجحوا ٧/٧، وده أكبرهم وأنضفهم ردًا: ٦٨٦ms
    // مقابل ٢٢٤٨ms لـ qwen، و allam كان بيكتب اعتذارات طويلة قبل ما يقول مش عارف.
    // **أي تغيير هنا لازم يعدي على نفس الاختبار** — الالتزام بالمصدر مش مضمون بحجم النموذج
    model: 'openai/gpt-oss-120b',
    available: () => Boolean(env.groqApiKey),
  },
};

// المخرج المطلوب من الاتنين. الحقول منفصلة عن بعض عن قصد: قرار "لقيت ولا لأ" لازم يبقى
// حقل منطقي صريح نقدر نتحقق منه، مش حاجة نستنتجها من نص الرد
const OUTPUT_FIELDS = {
  found_in_source: 'true لو الإجابة موجودة صراحةً في المصدر المرفق. false لو مش موجودة أو مش أكيدة.',
  blocked_topic: 'true لو السؤال بيمس أي موضوع من المواضيع الممنوعة.',
  // من غير المخرج ده مفيش طريقة النموذج يسأل بيها. تعليمة زي "اسأله في سنة كام الأول" كانت
  // مستحيلة التنفيذ لأن كل المخرجات كانت إما إجابة أو سكوت
  asks_question: 'true لو التعليمات العامة طالبة منك تسأل الطالب سؤال توضيحي قبل ما تجاوب.',
  answer: 'الرد للطالب بالعامية المصرية، جملتين على الأكثر. لو asks_question = true حط السؤال التوضيحي هنا. فاضي لو مفيش رد.',
};

const ANSWER_TOOL = {
  name: 'reply_to_student',
  description: 'سجّل نتيجة محاولة الإجابة على سؤال الطالب من المصدر المسموح.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      found_in_source: { type: 'boolean', description: OUTPUT_FIELDS.found_in_source },
      blocked_topic: { type: 'boolean', description: OUTPUT_FIELDS.blocked_topic },
      asks_question: { type: 'boolean', description: OUTPUT_FIELDS.asks_question },
      answer: { type: 'string', description: OUTPUT_FIELDS.answer },
    },
    required: ['found_in_source', 'blocked_topic', 'asks_question', 'answer'],
  },
};

// أي مخرج مش مطابق بيتعامل على إنه "مش لاقي" — الافتراض الآمن. نموذج رجّع حاجة غريبة
// أخطر من نموذج قال مش عارف، فالغموض بيروح للموظف مش للطالب
function normalizeOutput(raw) {
  if (!raw || typeof raw !== 'object') {
    return { found_in_source: false, blocked_topic: false, asks_question: false, answer: '' };
  }
  return {
    found_in_source: raw.found_in_source === true,
    blocked_topic: raw.blocked_topic === true,
    asks_question: raw.asks_question === true,
    answer: typeof raw.answer === 'string' ? raw.answer : '',
  };
}

// tool اختيارية: لو مبعوتة بتستخدم بدل أداة الرد الافتراضية. ده اللي بيخلّي نفس المزوّدين
// يخدموا الرد على الطالب والحصاد من المحادثات والملفات — نفس الطريق ونفس التحقق
async function callAnthropic({ systemPrompt, question, tool, maxTokens, model, supportsEffort = true }) {
  const activeTool = tool || ANSWER_TOOL;
  const response = await anthropicClient.messages.create({
    model: model || PROVIDERS.anthropic.model,
    max_tokens: maxTokens || 1024,
    // **مشروط مش دايمًا.** كان بيتبعت مع كل نداء، فـ Haiku كان بيرد
    // 400 "This model does not support the effort parameter" في كل مرة — يعني المزوّد
    // كان مذكور في القايمة ومختار من اللوحة وفاشل ١٠٠٪ من غير ما حد يعرف السبب
    ...(supportsEffort ? { output_config: { effort: 'low' } } : {}),
    // الكاش على المصدر: بيتبعت كامل مع كل سؤال وهو نفسه بالحرف، فالكتابة مرة والقراءة بعُشر
    // السعر. ttl ساعة لأن الرسايل بتيجي متفرقة بالليل وكاش الـ ٥ دقايق بيتكتب من أول وجديد
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [activeTool],
    tool_choice: { type: 'tool', name: activeTool.name },
    messages: [{ role: 'user', content: question }],
  });

  const usage = {
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
    cache_read_tokens: response.usage?.cache_read_input_tokens ?? null,
    cache_write_tokens: response.usage?.cache_creation_input_tokens ?? null,
  };
  if (response.stop_reason === 'refusal') {
    return { output: { found_in_source: false, blocked_topic: true, asks_question: false, answer: '' }, usage };
  }
  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('النموذج مانداش بالأداة');
  // الحصاد له شكل مخرج مختلف عن الرد، فبيترجّع خام والمنادي بيتحقق منه بنفسه
  return { output: tool ? toolUse.input : normalizeOutput(toolUse.input), usage };
}

// Groq بيتكلم بروتوكول OpenAI، فالنداء fetch مباشر — مفيش SDK رسمي ليه ومش محتاج واحد
// لنداء واحد. JSON mode بدل الأدوات: أثبت على النماذج المفتوحة، وبيشترط كلمة json في التعليمات
async function callGroq({ systemPrompt, question, tool, jsonShape, maxTokens }) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.groqApiKey}`,
    },
    body: JSON.stringify({
      model: PROVIDERS.groq.model,
      temperature: 0,
      max_tokens: maxTokens || 1024,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}

رد بـ JSON بالشكل ده بالظبط، من غير أي كلام قبله أو بعده:
${jsonShape || '{"found_in_source": true/false, "blocked_topic": true/false, "asks_question": true/false, "answer": "..."}'}`,
        },
        { role: 'user', content: question },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Groq رجّع ${response.status}: ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  let parsed = null;
  try { parsed = JSON.parse(content); } catch (_) { parsed = null; }
  return {
    output: tool ? parsed : normalizeOutput(parsed),
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? null,
      output_tokens: data.usage?.completion_tokens ?? null,
      cache_read_tokens: null,
      cache_write_tokens: null,
    },
  };
}

async function callProvider(providerKey, args) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`مزوّد غير معروف: ${providerKey}`);
  if (!provider.available()) throw new Error(`مفتاح ${provider.label} مش مضبوط على السيرفر`);
  return providerKey === 'groq'
    ? callGroq(args)
    : callAnthropic({ ...args, model: provider.model, supportsEffort: provider.supportsEffort !== false });
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key, label: p.label, model: p.model, available: p.available(),
  }));
}

module.exports = { PROVIDERS, callProvider, listProviders, OUTPUT_FIELDS };
