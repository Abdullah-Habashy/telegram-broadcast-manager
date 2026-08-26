const pool = require('../config/db');
const { callProvider } = require('./aiProviders');

// ---------- استخراج المعرفة من المحادثات اللي حصلت فعلًا ----------
//
// أفضل مصدر للمعرفة مش ملف بيتكتب من الصفر — هو ٦٦٠٠ سؤال حقيقي بإجابات موظفين حقيقيين
// موجودين في القاعدة أصلًا.
//
// **الفلتر هو التكرار.** الرد اللي الموظف كتبه ٣٣ مرة هو سؤال شائع بالتعريف؛ واللي اتكتب
// مرة واحدة غالبًا حالة خاصة مالهاش لازمة في مصدر عام. تجربة على البيانات الفعلية: أكتر
// الردود تكرارًا فيها "التواصل مع الدعم الفني" (٢٠١ مرة) و"الروابط في ملف PDF" (٨٥) و
// "المحاضرات كل سبت ٦ صباحًا" (٣٣) — كلها معرفة حقيقية. والباقي تحيات وشكر، والنموذج
// بيفرزها في الخطوة اللي بعدها.
//
// من غير فلتر التكرار كان لازم نبعت ٦٦٠٠ زوج للنموذج: تكلفة عالية ومخرج أغلبه دردشة.

// الحد الأدنى للتكرار. أقل من كده بيدخل حالات فردية، وأعلى بيفوّت معلومات حقيقية
const DEFAULT_MIN_REPEATS = 5;
// أكتر عدد ردود بتتبعت للنموذج في المرة الواحدة
const MAX_CLUSTERS = 40;

// الردود المتكررة، ومع كل واحد عيّنة من الأسئلة اللي سبقته — الأسئلة هي اللي بتقول
// الرد ده بيجاوب على إيه، لأن الرد لوحده مش دايمًا بيوضّح السؤال
const CLUSTERS_SQL = `
  WITH answers AS (
    SELECT TRIM(REGEXP_REPLACE(sm.content, '\\s+', ' ', 'g')) AS body,
           sm.ticket_id, sm.sent_at
    FROM support_messages sm
    WHERE sm.deleted_at IS NULL
      AND sm.sent_by IS NOT NULL
      AND sm.broadcast_recipient_id IS NULL
      AND sm.is_welcome = FALSE
      AND LENGTH(sm.content) BETWEEN 25 AND 600
  ),
  repeated AS (
    SELECT body, COUNT(*)::int AS uses
    FROM answers GROUP BY body HAVING COUNT(*) >= $1
    ORDER BY COUNT(*) DESC LIMIT $2
  )
  SELECT r.body, r.uses,
    (SELECT ARRAY_AGG(q) FROM (
       SELECT DISTINCT LEFT(TRIM(REGEXP_REPLACE(im.content, '\\s+', ' ', 'g')), 160) AS q
       FROM answers a
       JOIN tickets t ON t.id = a.ticket_id
       JOIN incoming_messages im ON im.contact_id = t.contact_id AND im.received_at < a.sent_at
       WHERE a.body = r.body AND COALESCE(im.content, '') <> ''
         AND im.received_at > a.sent_at - INTERVAL '10 minutes'
       LIMIT 4
     ) s) AS questions
  FROM repeated r
  ORDER BY r.uses DESC
`;

const MINE_TOOL = {
  name: 'extract_faq',
  description: 'حوّل الردود المتكررة لأسئلة وإجابات، وارمي اللي مش معرفة.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['add'] },
            target_id: { type: 'integer' },
            question: { type: 'string', description: 'السؤال بصيغة الطالب — عامية ومختصرة' },
            answer: { type: 'string', description: 'الإجابة زي ما الموظف بيقولها، منظّفة من التحية والاسم' },
            reason: { type: 'string', description: 'اتكرر كام مرة وليه ده معرفة' },
          },
          required: ['action', 'target_id', 'question', 'answer', 'reason'],
        },
      },
    },
    required: ['changes'],
  },
};

const MINE_PROMPT = `جاي لك ردود كتبها موظفو دعم لطلاب، وكل رد مكتوب جنبه اتكرر كام مرة وعيّنة من
أسئلة الطلاب اللي سبقته. مهمتك تطلّع منها أسئلة وإجابات لقاعدة معرفة.

المصدر الحالي (متقترحش حاجة موجودة فيه بالفعل):
{{SOURCE}}

**ارمي** — متطلّعش منها حاجة:
- التحيات والردود الاجتماعية: "وعليكم السلام"، "الشكر لله"، "ربنا يوفقك"، "أدام الله حمدك"
- تعريف الموظف بنفسه ("مع حضرتك فلان من منصة...")
- التشجيع العام ("شاطر"، "برافو"، "كمّل")
- أي رد خاص بطالب واحد بعينه أو بموقف مش بيتكرر

**طلّع** — دي معرفة:
- مواعيد وخطوات وروابط وطرق تواصل
- شرح إزاي حاجة بتتعمل على المنصة
- سياسات (الغياب، التسجيلات، المتابعة)

قواعد:
١. الإجابة تتنضّف من التحية واسم الموظف واسم الطالب — تبقى المعلومة بس.
٢. السؤال بصيغة الطالب زي ما هو في العيّنة، مش لغة رسمية.
٣. **متضيفش من عندك.** لو الرد مش واضح بيجاوب على إيه، ارميه.
٤. متطلّعش حاجة عن فلوس أو استرداد أو نتائج امتحانات — ممنوعة على البوت.
٥. لو نفس المعلومة في أكتر من رد، اطلّعها مرة واحدة بأوضح صياغة.
٦. action = add و target_id = 0 دايمًا.`;

async function findClusters({ minRepeats = DEFAULT_MIN_REPEATS, limit = MAX_CLUSTERS } = {}) {
  const { rows } = await pool.query(CLUSTERS_SQL, [minRepeats, limit]);
  return rows.map((r) => ({ answer: r.body, uses: r.uses, questions: r.questions || [] }));
}

async function mineFromHistory({ providerKey, minRepeats, limit }) {
  const clusters = await findClusters({ minRepeats, limit });
  if (!clusters.length) return { clusters: 0, changes: [] };

  const knowledge = await pool.query('SELECT id, question, answer FROM ai_knowledge WHERE is_active ORDER BY id');
  const source = knowledge.rows.length
    ? knowledge.rows.map((r) => `[#${r.id}] ${r.question} → ${r.answer}`).join('\n')
    : '(فاضي)';

  const payload = clusters.map((c, i) => {
    const asked = c.questions.length ? `\n   أسئلة سبقته: ${c.questions.join(' | ')}` : '';
    return `${i + 1}. (اتكرر ${c.uses} مرة) ${c.answer}${asked}`;
  }).join('\n\n');

  const { output } = await callProvider(providerKey, {
    systemPrompt: MINE_PROMPT.replace('{{SOURCE}}', source),
    question: payload,
    tool: MINE_TOOL,
    jsonShape: '{"changes": [{"action": "add", "target_id": 0, "question": "...", "answer": "...", "reason": "..."}]}',
    // المخرج هنا أطول من رد على طالب — عشرات الاقتراحات مش جملتين
    maxTokens: 8000,
  });

  const raw = Array.isArray(output?.changes) ? output.changes : [];
  return {
    clusters: clusters.length,
    changes: raw
      .filter((c) => c && String(c.question || '').trim() && String(c.answer || '').trim())
      .map((c) => ({
        action: 'add', target_id: null,
        question: String(c.question).trim(),
        answer: String(c.answer).trim(),
        reason: String(c.reason || '').trim(),
      })),
  };
}

module.exports = { findClusters, mineFromHistory, DEFAULT_MIN_REPEATS };
