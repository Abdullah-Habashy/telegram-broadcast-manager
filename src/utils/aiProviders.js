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
    label: 'Claude (مدفوع)',
    model: 'claude-opus-5',
    available: () => Boolean(anthropicClient),
  },
  groq: {
    key: 'groq',
    label: 'Llama 3.3 70B (Groq — مجاني)',
    model: 'llama-3.3-70b-versatile',
    available: () => Boolean(env.groqApiKey),
  },
};

// المخرج المطلوب من الاتنين. الحقول منفصلة عن بعض عن قصد: قرار "لقيت ولا لأ" لازم يبقى
// حقل منطقي صريح نقدر نتحقق منه، مش حاجة نستنتجها من نص الرد
const OUTPUT_FIELDS = {
  found_in_source: 'true لو الإجابة موجودة صراحةً في المصدر المرفق. false لو مش موجودة أو مش أكيدة.',
  blocked_topic: 'true لو السؤال بيمس أي موضوع من المواضيع الممنوعة.',
  answer: 'الرد للطالب بالعامية المصرية، جملتين على الأكثر. فاضي لو found_in_source = false أو blocked_topic = true.',
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
      answer: { type: 'string', description: OUTPUT_FIELDS.answer },
    },
    required: ['found_in_source', 'blocked_topic', 'answer'],
  },
};

// أي مخرج مش مطابق بيتعامل على إنه "مش لاقي" — الافتراض الآمن. نموذج رجّع حاجة غريبة
// أخطر من نموذج قال مش عارف، فالغموض بيروح للموظف مش للطالب
function normalizeOutput(raw) {
  if (!raw || typeof raw !== 'object') return { found_in_source: false, blocked_topic: false, answer: '' };
  return {
    found_in_source: raw.found_in_source === true,
    blocked_topic: raw.blocked_topic === true,
    answer: typeof raw.answer === 'string' ? raw.answer : '',
  };
}

async function callAnthropic({ systemPrompt, question }) {
  const response = await anthropicClient.messages.create({
    model: PROVIDERS.anthropic.model,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    // الكاش على المصدر: بيتبعت كامل مع كل سؤال وهو نفسه بالحرف، فالكتابة مرة والقراءة بعُشر
    // السعر. ttl ساعة لأن الرسايل بتيجي متفرقة بالليل وكاش الـ ٥ دقايق بيتكتب من أول وجديد
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [ANSWER_TOOL],
    tool_choice: { type: 'tool', name: ANSWER_TOOL.name },
    messages: [{ role: 'user', content: question }],
  });

  const usage = {
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
    cache_read_tokens: response.usage?.cache_read_input_tokens ?? null,
    cache_write_tokens: response.usage?.cache_creation_input_tokens ?? null,
  };
  if (response.stop_reason === 'refusal') {
    return { output: { found_in_source: false, blocked_topic: true, answer: '' }, usage };
  }
  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('النموذج مانداش بالأداة');
  return { output: normalizeOutput(toolUse.input), usage };
}

// Groq بيتكلم بروتوكول OpenAI، فالنداء fetch مباشر — مفيش SDK رسمي ليه ومش محتاج واحد
// لنداء واحد. JSON mode بدل الأدوات: أثبت على النماذج المفتوحة، وبيشترط كلمة json في التعليمات
async function callGroq({ systemPrompt, question }) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.groqApiKey}`,
    },
    body: JSON.stringify({
      model: PROVIDERS.groq.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}

رد بـ JSON بالشكل ده بالظبط، من غير أي كلام قبله أو بعده:
{"found_in_source": true/false, "blocked_topic": true/false, "answer": "..."}`,
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
    output: normalizeOutput(parsed),
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
  return providerKey === 'groq' ? callGroq(args) : callAnthropic(args);
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key, label: p.label, model: p.model, available: p.available(),
  }));
}

module.exports = { PROVIDERS, callProvider, listProviders, OUTPUT_FIELDS };
