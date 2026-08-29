const crypto = require('crypto');
const pool = require('../config/db');
const { finalizeAttempt, recalculateAttempt } = require('../utils/quizScoring');

// ---------- إدارة الاختبارات من اللوحة ----------

// الرابط المعروض للموظف هو المختصر لما يكون موجود — التوكن الطويل بيفضل شغّال على نفس
// الصفحة، بس محدش محتاج ينسخه بعد كده
function quizUrl(req, quiz) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/q/${quiz.slug || quiz.token}`;
}

// حروف من غير المتشابهات (0/O و 1/l/i) — الكود ده بيتقال في فيديو وبيتكتب على الموبايل،
// والحرف اللي بيتلخبط فيه الطالب بيولّد تذكرة دعم
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateSlug() {
  return Array.from({ length: 6 }, () =>
    SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)]).join('');
}

// الموظف بيقدر يكتبه بنفسه (اسم الدرس مثلًا). بنقبل إنجليزي وأرقام وشرطة بس — العربي في
// الرابط بيتحوّل لـ percent-encoding وبيبقى أوحش من التوكن اللي بنهرب منه
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;

function normalizeSlug(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!value) return null;
  return SLUG_PATTERN.test(value) ? value : false;
}

async function listQuizzes(req, res) {
  const { rows } = await pool.query(
    `SELECT q.id, q.title, q.description, q.token, q.slug, q.time_limit_minutes, q.is_open,
            q.show_score_to_student, q.created_at,
            (SELECT COUNT(*)::int FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count,
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.submitted_at IS NOT NULL) AS submitted_count,
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.submitted_at IS NULL) AS in_progress_count,
            -- محتاج تدخّل: تصحيح آلي فشل أو سؤال مقالي لسه من غير درجة
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.grading_status = 'partial') AS needs_review_count
     FROM quizzes q ORDER BY q.created_at DESC`);
  res.json(rows.map((row) => ({ ...row, url: quizUrl(req, row) })));
}

async function getQuiz(req, res) {
  const quizId = Number(req.params.id);
  const quizResult = await pool.query('SELECT * FROM quizzes WHERE id = $1', [quizId]);
  const quiz = quizResult.rows[0];
  if (!quiz) return res.status(404).json({ error: 'الاختبار مش موجود' });

  const questions = await pool.query(
    `SELECT id, position, kind, text, points, options, correct_option, reference_answer, grading_notes
     FROM quiz_questions WHERE quiz_id = $1 ORDER BY position, id`, [quizId]);
  const attemptCount = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_attempts WHERE quiz_id = $1', [quizId]);

  res.json({
    ...quiz,
    url: quizUrl(req, quiz),
    // الواجهة بتقفل زرار حذف السؤال لما يبقى فيه محاولات — الحذف بيمسح إجابات طلاب معاه
    attempt_count: attemptCount.rows[0].count,
    questions: questions.rows.map((row) => ({ ...row, points: Number(row.points) })),
  });
}

const SLUG_HELP = 'الرابط المختصر يبقى إنجليزي وأرقام وشرطة بس، من حرفين لأربعين — زي bio-1 أو olom5';

async function createQuiz(req, res) {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'عنوان الاختبار مطلوب' });
  const timeLimit = req.body?.time_limit_minutes ? Number(req.body.time_limit_minutes) : null;
  const token = crypto.randomBytes(32).toString('hex');

  const requested = normalizeSlug(req.body?.slug);
  if (requested === false) return res.status(400).json({ error: SLUG_HELP });

  const params = (slug) => [title, String(req.body?.description || '').trim() || null, token, slug,
    Number.isFinite(timeLimit) && timeLimit > 0 ? timeLimit : null,
    req.body?.show_score_to_student !== false, req.session.userId];
  const insert = `INSERT INTO quizzes (title, description, token, slug, time_limit_minutes, show_score_to_student, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;

  // الموظف اختار الرابط بنفسه؟ التعارض بيترد عليه برسالة. مااخترش؟ بنولّد كود ونعيد
  // المحاولة لحد ما يعدّي — الاحتمال ضعيف بس السكوت عنه معناه اختبار من غير رابط مختصر
  if (requested) {
    try {
      const { rows } = await pool.query(insert, params(requested));
      return res.json({ ...rows[0], url: quizUrl(req, rows[0]) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'الرابط المختصر ده مستخدم في اختبار تاني — اختار غيره' });
      throw error;
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rows } = await pool.query(insert, params(generateSlug()));
      return res.json({ ...rows[0], url: quizUrl(req, rows[0]) });
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
  }
  return res.status(500).json({ error: 'مقدرناش نولّد رابط مختصر — جرّب تاني' });
}

async function updateQuiz(req, res) {
  const quizId = Number(req.params.id);
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'عنوان الاختبار مطلوب' });
  const timeLimit = req.body?.time_limit_minutes ? Number(req.body.time_limit_minutes) : null;
  const requested = normalizeSlug(req.body?.slug);
  if (requested === false) return res.status(400).json({ error: SLUG_HELP });

  let rows;
  try {
    // COALESCE: الطلب اللي مابيبعتش slug (زي زرار القفل والفتح) مايمسحش الرابط الموجود
    ({ rows } = await pool.query(
      `UPDATE quizzes SET title = $1, description = $2, time_limit_minutes = $3,
              is_open = $4, show_score_to_student = $5, slug = COALESCE($6, slug), updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [title, String(req.body?.description || '').trim() || null,
        Number.isFinite(timeLimit) && timeLimit > 0 ? timeLimit : null,
        req.body?.is_open !== false, req.body?.show_score_to_student !== false, requested, quizId]));
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'الرابط المختصر ده مستخدم في اختبار تاني — اختار غيره' });
    throw error;
  }
  if (!rows.length) return res.status(404).json({ error: 'الاختبار مش موجود' });
  res.json({ ...rows[0], url: quizUrl(req, rows[0]) });
}

async function deleteQuiz(req, res) {
  const quizId = Number(req.params.id);
  const attempts = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_attempts WHERE quiz_id = $1', [quizId]);
  // الحذف بيمسح إجابات الطلاب معاه (ON DELETE CASCADE) ومفيش رجوع. القفل بيعطّل الرابط
  // ويحافظ على النتايج، وهو المطلوب في ٩٩٪ من الحالات
  if (attempts.rows[0].count > 0 && req.body?.confirm !== true) {
    return res.status(409).json({
      error: `الاختبار ده فيه ${attempts.rows[0].count} محاولة وحذفه هيمسح إجابات الطلاب. اقفله بدل ما تمسحه، أو أكّد الحذف.`,
      needs_confirmation: true,
    });
  }
  await pool.query('DELETE FROM quizzes WHERE id = $1', [quizId]);
  res.json({ ok: true });
}

// ---------- الأسئلة ----------
// بتتبعت كلها مرة واحدة (الشكل الطبيعي لمحرر أسئلة). السؤال اللي ليه id بيتحدّث، واللي
// من غير id بيتضاف، واللي اختفى من القايمة بيتمسح — **إلا لو فيه محاولات**
async function saveQuestions(req, res) {
  const quizId = Number(req.params.id);
  const incoming = Array.isArray(req.body?.questions) ? req.body.questions : null;
  if (!incoming) return res.status(400).json({ error: 'الأسئلة مطلوبة' });

  for (const [index, question] of incoming.entries()) {
    const text = String(question?.text || '').trim();
    if (!text) return res.status(400).json({ error: `السؤال رقم ${index + 1} من غير نص` });
    if (question.kind === 'mcq') {
      const options = (question.options || []).map((option) => String(option || '').trim()).filter(Boolean);
      if (options.length < 2) return res.status(400).json({ error: `السؤال رقم ${index + 1} محتاج اختيارين على الأقل` });
      if (!Number.isInteger(Number(question.correct_option)) || Number(question.correct_option) >= options.length) {
        return res.status(400).json({ error: `حدّد الإجابة الصح للسؤال رقم ${index + 1}` });
      }
    } else if (question.kind === 'essay') {
      // **الإجابة المرجعية شرط.** من غيرها التصحيح الآلي مالوش معيار يقارن بيه، والسؤال
      // كان هيتحسب غلط لكل الطلاب من غير أي إشارة إن العيب في السؤال مش في الإجابات
      if (!String(question.reference_answer || '').trim()) {
        return res.status(400).json({ error: `السؤال المقالي رقم ${index + 1} محتاج إجابة مرجعية — التصحيح الآلي بيقارن بيها` });
      }
    } else {
      return res.status(400).json({ error: `نوع السؤال رقم ${index + 1} غير معروف` });
    }
  }

  const existing = await pool.query('SELECT id FROM quiz_questions WHERE quiz_id = $1', [quizId]);
  const existingIds = new Set(existing.rows.map((row) => row.id));
  const keptIds = new Set(incoming.map((question) => Number(question.id)).filter((id) => existingIds.has(id)));
  const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

  if (removedIds.length) {
    const attempts = await pool.query(
      'SELECT COUNT(*)::int AS count FROM quiz_attempts WHERE quiz_id = $1', [quizId]);
    if (attempts.rows[0].count > 0) {
      return res.status(409).json({ error: 'مينفعش تحذف سؤال من اختبار طلاب حلّوه — الإجابات بتتمسح معاه. اعمل اختبار جديد بدل التعديل.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (removedIds.length) {
      await client.query('DELETE FROM quiz_questions WHERE quiz_id = $1 AND id = ANY($2::int[])', [quizId, removedIds]);
    }
    for (const [index, question] of incoming.entries()) {
      const isMcq = question.kind === 'mcq';
      const options = isMcq ? (question.options || []).map((option) => String(option || '').trim()).filter(Boolean) : [];
      const points = Number(question.points) > 0 ? Number(question.points) : 1;
      const params = [
        quizId, index, question.kind, String(question.text).trim(), points,
        JSON.stringify(options), isMcq ? Number(question.correct_option) : null,
        isMcq ? null : String(question.reference_answer || '').trim(),
        isMcq ? null : (String(question.grading_notes || '').trim() || null),
      ];
      if (keptIds.has(Number(question.id))) {
        await client.query(
          `UPDATE quiz_questions SET quiz_id = $1, position = $2, kind = $3, text = $4, points = $5,
                  options = $6::jsonb, correct_option = $7, reference_answer = $8, grading_notes = $9
           WHERE id = $10`, [...params, Number(question.id)]);
      } else {
        await client.query(
          `INSERT INTO quiz_questions (quiz_id, position, kind, text, points, options, correct_option, reference_answer, grading_notes)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`, params);
      }
    }
    await client.query('UPDATE quizzes SET updated_at = NOW() WHERE id = $1', [quizId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}

// ---------- المحاولات والنتايج ----------
async function listAttempts(req, res) {
  const quizId = Number(req.params.id);
  const { rows } = await pool.query(
    `SELECT a.id, a.student_name, a.phone, a.tafra_student_id, a.started_at, a.deadline_at,
            a.submitted_at, a.is_late, a.score, a.max_score, a.grading_status, a.grading_error,
            s.name AS platform_name
     FROM quiz_attempts a
     LEFT JOIN tafra_students s ON s.tafra_student_id = a.tafra_student_id
     WHERE a.quiz_id = $1
     ORDER BY a.submitted_at DESC NULLS FIRST, a.started_at DESC`, [quizId]);
  res.json(rows.map((row) => ({
    ...row,
    score: row.score === null ? null : Number(row.score),
    max_score: row.max_score === null ? null : Number(row.max_score),
    // مش مطابق = رقمه مش على منصة طفرة. الموظف بيشوفها عشان يربطه بإيده لو حب
    matched: row.tafra_student_id !== null,
  })));
}

async function getAttempt(req, res) {
  const attemptId = Number(req.params.attemptId);
  const attemptResult = await pool.query(
    `SELECT a.*, q.title, s.name AS platform_name
     FROM quiz_attempts a
     JOIN quizzes q ON q.id = a.quiz_id
     LEFT JOIN tafra_students s ON s.tafra_student_id = a.tafra_student_id
     WHERE a.id = $1`, [attemptId]);
  const attempt = attemptResult.rows[0];
  if (!attempt) return res.status(404).json({ error: 'المحاولة مش موجودة' });

  const { rows } = await pool.query(
    `SELECT q.id AS question_id, q.position, q.kind, q.text, q.points, q.options,
            q.correct_option, q.reference_answer,
            an.id AS answer_id, an.selected_option, an.essay_text, an.awarded_points,
            an.is_correct, an.ai_verdict, an.ai_reason, an.ai_provider, an.graded_by,
            u.name AS graded_by_name
     FROM quiz_questions q
     LEFT JOIN quiz_answers an ON an.question_id = q.id AND an.attempt_id = $1
     LEFT JOIN users u ON u.id = an.graded_by_user
     WHERE q.quiz_id = $2 ORDER BY q.position, q.id`, [attemptId, attempt.quiz_id]);

  res.json({
    attempt: {
      ...attempt,
      score: attempt.score === null ? null : Number(attempt.score),
      max_score: attempt.max_score === null ? null : Number(attempt.max_score),
    },
    answers: rows.map((row) => ({
      ...row,
      points: Number(row.points),
      awarded_points: row.awarded_points === null ? null : Number(row.awarded_points),
    })),
  });
}

// الموظف بيعدّل درجة سؤال. graded_by = 'staff' بيقفل السؤال ده قدام أي إعادة تصحيح آلي —
// حكم بني آدم مابيتمسحش بنداء نموذج
async function gradeAnswer(req, res) {
  const attemptId = Number(req.params.attemptId);
  const questionId = Number(req.params.questionId);
  const points = Number(req.body?.awarded_points);
  if (!Number.isFinite(points) || points < 0) return res.status(400).json({ error: 'الدرجة غير صالحة' });

  const questionResult = await pool.query(
    `SELECT q.points FROM quiz_questions q
     JOIN quiz_attempts a ON a.quiz_id = q.quiz_id
     WHERE q.id = $1 AND a.id = $2`, [questionId, attemptId]);
  if (!questionResult.rows.length) return res.status(404).json({ error: 'السؤال مش في الاختبار ده' });
  const maxPoints = Number(questionResult.rows[0].points);
  if (points > maxPoints) return res.status(400).json({ error: `الدرجة أكبر من درجة السؤال (${maxPoints})` });

  await pool.query(
    `INSERT INTO quiz_answers (attempt_id, question_id, awarded_points, is_correct, graded_by, graded_by_user, graded_at)
     VALUES ($1, $2, $3, $4, 'staff', $5, NOW())
     ON CONFLICT (attempt_id, question_id) DO UPDATE
     SET awarded_points = EXCLUDED.awarded_points, is_correct = EXCLUDED.is_correct,
         graded_by = 'staff', graded_by_user = EXCLUDED.graded_by_user, graded_at = NOW()`,
    [attemptId, questionId, points, points >= maxPoints, req.session.userId]);

  const result = await recalculateAttempt(attemptId);
  res.json(result);
}

// إعادة محاولة التصحيح الآلي — للمحاولات اللي فشل فيها النموذج (grading_status = 'partial')
// أو اللي وقتها خلص وهي لسه مفتوحة
async function regradeAttempt(req, res) {
  const attemptId = Number(req.params.attemptId);
  const result = await finalizeAttempt(attemptId);
  res.json(result);
}

module.exports = {
  listQuizzes, getQuiz, createQuiz, updateQuiz, deleteQuiz, saveQuestions,
  listAttempts, getAttempt, gradeAnswer, regradeAttempt,
};
