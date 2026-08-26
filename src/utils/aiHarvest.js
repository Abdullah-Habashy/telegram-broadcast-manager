const pool = require('../config/db');
const { callProvider, PROVIDERS } = require('./aiProviders');

// ---------- حصاد المعرفة من المحادثات والملفات ----------
//
// الفكرة: الأدمن بيكلّم النموذج زي ما الطالب هيكلّمه، فالثغرات بتبان لوحدها — النموذج بيقول
// "مش لاقي"، والأدمن بيكتب الإجابة الصح في الرسالة اللي بعدها. في الآخر بيتحصد اللي اتقال.
//
// **الحصاد بيقترح مابيكتبش.** لو النموذج كتب في مصادره مباشرة، المصدر يفقد كونه "حقيقة
// موثوقة" — وده اللي الميزة كلها قايمة عليه. كل اقتراح بيتعرض للمراجعة، والأدمن هو اللي
// بيوافق. الاقتراح ممكن يكون إضافة جديدة أو **تصحيح** لمعلومة موجودة، وده مهم: المحادثة
// غالبًا بتكتشف إن معلومة قديمة بقت غلط، مش بس إن فيه معلومة ناقصة.

// أقصى عدد اقتراحات في المرة — محادثة طويلة ممكن تولّد عشرات، ومراجعة ٥٠ صف مرة واحدة
// معناها موافقة بالجملة من غير قراءة، وده بيهزم الغرض من المراجعة أصلًا
const MAX_SUGGESTIONS = 15;

function knowledgeAsText(rows) {
  if (!rows.length) return '(المصدر فاضي دلوقتي)';
  return rows.map((row) => `[#${row.id}] س: ${row.question}\n      ج: ${row.answer}`).join('\n\n');
}

const HARVEST_TOOL = {
  name: 'suggest_knowledge_changes',
  description: 'اقترح إضافات أو تصحيحات لقاعدة المعرفة بناءً على المحادثة.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      changes: {
        type: 'array',
        description: `الاقتراحات، ${MAX_SUGGESTIONS} على الأكثر. قايمة فاضية لو المحادثة مافيهاش أي معلومة جديدة أو تصحيح.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['add', 'update'], description: 'add لمعلومة جديدة، update لتصحيح معلومة موجودة' },
            target_id: { type: 'integer', description: 'رقم المعلومة اللي هتتصحّح. 0 لو action = add' },
            question: { type: 'string', description: 'السؤال بصيغة الطالب — زي ما هو هيسأله بالظبط' },
            answer: { type: 'string', description: 'الإجابة بالعامية المصرية، مختصرة وواضحة' },
            reason: { type: 'string', description: 'سطر واحد: ده اتاخد منين في المحادثة وليه' },
          },
          required: ['action', 'target_id', 'question', 'answer', 'reason'],
        },
      },
    },
    required: ['changes'],
  },
};

const HARVEST_PROMPT = `مهمتك تقرا المحادثة دي وتطلّع منها المعلومات اللي تستاهل تتحفظ في قاعدة معرفة بوت دعم طلاب.

المصدر الحالي:
{{SOURCE}}

القواعد:

١. **اطلّع بس اللي اتقال في المحادثة صراحةً.** متضيفش من معرفتك العامة ومتستنتجش. لو المحادثة
   مافيهاش معلومة جديدة، رجّع قايمة فاضية — ده تصرف صح مش فشل.

٢. **لو المحادثة بتصحّح معلومة موجودة في المصدر**، استخدم action = update وحط رقمها في
   target_id. التصحيح أهم من الإضافة: معلومة قديمة غلط بتوصل للطلاب كل يوم.

٣. صيغة السؤال زي ما الطالب هيكتبه — عامية ومختصرة، مش لغة رسمية.

٤. متقترحش معلومة موجودة بالفعل بنفس المعنى، حتى لو الصياغة مختلفة.

٥. متقترحش أي حاجة عن فلوس أو استرداد أو مواعيد امتحانات أو نتائج — دي مواضيع ممنوعة على
   البوت أصلًا، ووجودها في المصدر بلا فايدة.

٦. الإجابة تكون قائمة بذاتها ومفهومة من غير سياق المحادثة.`;

// نفس الأداة على المزوّدين: Claude بينده بيها، وGroq بيرجّع JSON بنفس الشكل
async function harvestFromMessages({ messages, providerKey }) {
  const knowledge = await pool.query('SELECT id, question, answer FROM ai_knowledge WHERE is_active ORDER BY id');
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'الأدمن' : 'البوت'}: ${m.content}`)
    .join('\n');

  const systemPrompt = HARVEST_PROMPT.replace('{{SOURCE}}', knowledgeAsText(knowledge.rows));
  const { output } = await callProvider(providerKey, {
    systemPrompt,
    question: `المحادثة:\n\n${transcript}`,
    tool: HARVEST_TOOL,
    jsonShape: '{"changes": [{"action": "add|update", "target_id": 0, "question": "...", "answer": "...", "reason": "..."}]}',
  });

  const raw = Array.isArray(output?.changes) ? output.changes : [];
  const validIds = new Set(knowledge.rows.map((r) => r.id));
  // التنقية هنا مش تجميلية: النموذج ممكن يقترح تحديث لرقم مش موجود، أو يرجّع حقول ناقصة.
  // الاقتراح المكسور بيتشال بدل ما يتعرض ويتوافق عليه بالغلط
  return raw
    .filter((c) => c && typeof c.question === 'string' && typeof c.answer === 'string'
      && c.question.trim() && c.answer.trim())
    .map((c) => ({
      action: c.action === 'update' && validIds.has(Number(c.target_id)) ? 'update' : 'add',
      target_id: c.action === 'update' && validIds.has(Number(c.target_id)) ? Number(c.target_id) : null,
      question: c.question.trim(),
      answer: c.answer.trim(),
      reason: String(c.reason || '').trim(),
    }))
    .slice(0, MAX_SUGGESTIONS);
}

const FILE_PROMPT = `مهمتك تحوّل النص ده لأسئلة وإجابات لقاعدة معرفة بوت دعم طلاب.

المصدر الحالي (متقترحش حاجة موجودة فيه بالفعل):
{{SOURCE}}

القواعد:
١. **اطلّع بس اللي مكتوب في النص.** متضيفش من معرفتك ومتستنتجش.
٢. السؤال بصيغة الطالب — عامية ومختصرة زي ما هو هيسأله.
٣. الإجابة قائمة بذاتها ومفهومة من غير النص الأصلي.
٤. متطلّعش حاجة عن فلوس أو استرداد أو مواعيد امتحانات أو نتائج — ممنوعة على البوت.
٥. كل اقتراح action = add و target_id = 0.`;

async function harvestFromText({ text, providerKey }) {
  const knowledge = await pool.query('SELECT id, question, answer FROM ai_knowledge WHERE is_active ORDER BY id');
  const systemPrompt = FILE_PROMPT.replace('{{SOURCE}}', knowledgeAsText(knowledge.rows));
  const { output } = await callProvider(providerKey, {
    systemPrompt,
    question: `النص:\n\n${text}`,
    tool: HARVEST_TOOL,
    jsonShape: '{"changes": [{"action": "add", "target_id": 0, "question": "...", "answer": "...", "reason": "..."}]}',
  });
  const raw = Array.isArray(output?.changes) ? output.changes : [];
  return raw
    .filter((c) => c && typeof c.question === 'string' && typeof c.answer === 'string'
      && c.question.trim() && c.answer.trim())
    .map((c) => ({
      action: 'add', target_id: null,
      question: c.question.trim(), answer: c.answer.trim(),
      reason: String(c.reason || '').trim(),
    }))
    .slice(0, MAX_SUGGESTIONS);
}

// التطبيق بعد الموافقة. بيتم في ترانزاكشن واحدة عشان موافقة على ١٠ اقتراحات تتحفظ كلها أو
// ولا واحد — نص قاعدة معرفة محدّثة أسوأ من واحدة مش محدّثة، لأن مفيش طريقة تعرف بيها إيه اتطبّق
async function applyChanges(changes, source = 'chat') {
  const client = await pool.connect();
  let added = 0;
  let updated = 0;
  try {
    await client.query('BEGIN');
    for (const change of changes) {
      if (change.action === 'update' && change.target_id) {
        const result = await client.query(
          `UPDATE ai_knowledge SET question = $2, answer = $3, source = $4, updated_at = NOW()
           WHERE id = $1 RETURNING id`,
          [change.target_id, change.question, change.answer, source]
        );
        if (result.rowCount) updated += 1;
      } else {
        await client.query(
          'INSERT INTO ai_knowledge (question, answer, source) VALUES ($1, $2, $3)',
          [change.question, change.answer, source]
        );
        added += 1;
      }
    }
    await client.query('COMMIT');
    return { added, updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { harvestFromMessages, harvestFromText, applyChanges, MAX_SUGGESTIONS, PROVIDERS };
