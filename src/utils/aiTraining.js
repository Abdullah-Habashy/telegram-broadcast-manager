const pool = require('../config/db');
const { generateReply } = require('./aiReply');

// ---------- مساحة التدريب: تشغيل النموذج على محادثة حصلت فعلًا ----------
//
// **مفيش أي رسالة بتتبعت لأي طالب من الملف ده.** المحادثة قديمة والطالب اتردّ عليه من شهور —
// إحنا بس بنعدّي أسئلته على النموذج ونشوف كان هيقول إيه. `generateReply` بترجّع النص
// ومابتبعتش، والإرسال دايمًا عند اللي بينده (شوف الملاحظة في `aiReply.js`).
//
// **وكل سؤال بيتبعت لوحده من غير سياق المحادثة** — زي الإنتاج بالظبط. لو بعتنا السياق كله
// كنا هنقيس قدرة النموذج على محادثة كاملة، وهو أصلًا في الإنتاج بيشوف رسالة واحدة يتيمة.

// سقف الرسايل في الجلسة الواحدة. مش خوفًا من التكلفة بس: مراجعة ٨٠ رد في قعدة واحدة معناها
// تقييم بالجملة من غير قراءة، وده بيهزم الغرض من التقييم أصلًا
const MAX_MESSAGES = 40;

// تلاتة مع بعض. المزوّد بيتحمّل أكتر، بس الجلسة كلها بتتعرض دفعة واحدة في الآخر، فالفرق بين
// ٣ و١٠ ثواني معدودة مقابل ضغط أعلى على المفتاح المشترك مع الرد الآلي الحقيقي
const CONCURRENCY = 3;

// أقصر من كده مش سؤال: "تمام" و"شكرًا" و"👍" بتملا المحادثات وبتستهلك نداء بلا فايدة
const MIN_QUESTION_LENGTH = 3;

// **الرسايل النائبة عن الوسائط مش أسئلة.** الفيديو والصوت والملصق بيتسجّلوا كسطر نصي في
// المحادثة (`🏷️ ملصق (اتطلب منه يبعت مكتوب أو صورة)`) عشان الموظف يعرف إن الطالب حاول —
// وطلعت في أول تجربة على الإنتاج كأنها سؤال، فالنموذج بيتنده على ملصق. الليبلات دي في
// `UNSUPPORTED_MEDIA` جوه `bot/handlers/message.js`
const MEDIA_PLACEHOLDER_PATTERN = '^\\s*(🎥|🎤|🎵|🏷️|🎞️|📷)';

// أحدث الرسايل مش أقدمها: المحادثة الطويلة بتبدأ بترحيب وتعارف، والأسئلة الحقيقية بتيجي بعدين.
// وبيترتبوا تصاعدي تاني عشان العرض يبقى بترتيب المحادثة
const QUESTIONS_SQL = `
  SELECT * FROM (
    SELECT im.id, im.content, im.received_at,
      (SELECT sm.content FROM support_messages sm
        WHERE sm.ticket_id = $1 AND sm.sent_at > im.received_at
          AND sm.deleted_at IS NULL AND sm.sent_by IS NOT NULL
          AND sm.broadcast_recipient_id IS NULL
          AND COALESCE(TRIM(sm.content), '') <> ''
        ORDER BY sm.sent_at LIMIT 1) AS agent_reply
    FROM incoming_messages im
    WHERE im.contact_id = $2
      AND LENGTH(TRIM(COALESCE(im.content, ''))) >= ${MIN_QUESTION_LENGTH}
      AND im.content !~ '${MEDIA_PLACEHOLDER_PATTERN}'
    ORDER BY im.received_at DESC
    LIMIT $3
  ) recent
  ORDER BY received_at`;

async function loadTicketQuestions(ticketId, limit = MAX_MESSAGES) {
  const ticket = await pool.query(
    `SELECT t.id, t.contact_id,
       COALESCE(s.name, c.first_name, c.telegram_username, c.chat_id::text) AS student_name
     FROM tickets t
     JOIN contacts c ON c.id = t.contact_id
     LEFT JOIN LATERAL (
       SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
     ) s ON true
     WHERE t.id = $1`,
    [ticketId]
  );
  if (!ticket.rows[0]) return null;

  const capped = Math.min(Number(limit) || MAX_MESSAGES, MAX_MESSAGES);
  const { rows } = await pool.query(QUESTIONS_SQL, [ticketId, ticket.rows[0].contact_id, capped]);
  return { ticket: ticket.rows[0], questions: rows };
}

// نفس ترتيب المدخلات في المخرجات مهما خلص أنهي نداء الأول — الجلسة بتتعرض بترتيب المحادثة،
// ولو الترتيب اتبعثر السؤال بيبان جنب رد سؤال تاني
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runTraining({ ticketId, provider, userId, limit }) {
  const loaded = await loadTicketQuestions(ticketId, limit);
  if (!loaded) return { ok: false, status: 404, error: 'التذكرة غير موجودة' };
  if (!loaded.questions.length) {
    return { ok: false, status: 400, error: 'المحادثة دي مفيهاش رسايل نصية تتجرّب' };
  }

  const replies = await mapWithConcurrency(loaded.questions, CONCURRENCY, async (row) => {
    const startedAt = Date.now();
    try {
      // **بيتخطّى شرط التشغيل عن قصد**: الرد الآلي مقفول دلوقتي، والتدريب هو الطريق اللي
      // المفروض يوصل بيه لدرجة يتشغّل عندها
      const result = await generateReply({
        question: row.content, provider, skipEnabledCheck: true,
      });
      return { ...result, latency_ms: result.latency_ms ?? (Date.now() - startedAt) };
    } catch (error) {
      // فشل نداء واحد مايوقّفش الجلسة كلها — بيتسجّل كصف نتيجته error والباقي بيكمّل
      return { outcome: 'error', detail: error.message, latency_ms: Date.now() - startedAt };
    }
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      'INSERT INTO ai_training_runs (ticket_id, provider, started_by) VALUES ($1, $2, $3) RETURNING id, created_at',
      [ticketId, provider || null, userId || null]
    );
    const runId = runResult.rows[0].id;

    const items = [];
    for (let index = 0; index < loaded.questions.length; index += 1) {
      const question = loaded.questions[index];
      const reply = replies[index] || {};
      const inserted = await client.query(
        `INSERT INTO ai_training_items
           (run_id, incoming_message_id, position, question, agent_reply, answer, outcome, detail, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, position, question, agent_reply, answer, outcome, detail, latency_ms,
                   verdict, note, knowledge_id, instruction_id`,
        [runId, question.id, index, question.content, question.agent_reply || null,
          reply.answer || null, reply.outcome || 'error', reply.detail || null,
          reply.latency_ms ?? null]
      );
      items.push(inserted.rows[0]);
    }
    await client.query('COMMIT');

    return {
      ok: true,
      run: {
        id: runId,
        ticket_id: ticketId,
        student_name: loaded.ticket.student_name,
        provider: provider || null,
        created_at: runResult.rows[0].created_at,
      },
      items,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// الفلتر مصدّر عشان استعلام البحث في الكنترولر يعدّ بنفس القاعدة بالظبط — لو افترقوا،
// الشاشة بتقول «١١٨ رسالة» والتشغيل يطلّع ٣٠ ومحدش يعرف ليه
module.exports = {
  runTraining, loadTicketQuestions, MAX_MESSAGES,
  MIN_QUESTION_LENGTH, MEDIA_PLACEHOLDER_PATTERN,
};
