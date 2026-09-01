const pool = require('../config/db');
const { gradeEssayAnswer } = require('./quizGrading');

// ---------- إنهاء المحاولة وحساب الدرجة ----------
//
// مشترك بين تلات مسارات: الطالب بيسلّم بنفسه، والوقت خلص وهو قافل الصفحة (jobs/quizFinalizer)،
// والموظف بيضغط "صحّح دلوقتي". التلاتة بيعملوا نفس الحاجة بالظبط فلازم يبقوا كود واحد.

// الفرع بيتبعت مع رأسه: "رأس السؤال\nأ) نص الفرع". من غير الرأس، فرع زي "اذكر اتنين
// منهم" بيوصل النموذج بلا سياق والحكم بيبقى عشوائي
function questionTextForGrading(question) {
  if (!question.parent_text) return question.text;
  const label = question.label ? `${question.label}) ` : '';
  return `${question.parent_text}\n\n${label}${question.text}`;
}

// **التصحيح الآلي مش شرط لإنهاء المحاولة.** لو النموذج فشل (مفتاح ناقص، شبكة، مخرج غريب)،
// الاختياري بيتحسب والمقالي بيتساب من غير درجة والحالة بتبقى partial — الموظف بيشوفها
// في اللوحة ويحطها بإيده. البديل (نرمي الطلب كله) كان معناه إن الطالب يفقد إجاباته
// عشان مشكلة عندنا إحنا.
async function gradeEssays(answers, questions) {
  const essays = answers.filter((answer) => {
    const question = questions.get(answer.question_id);
    return question && question.kind === 'essay';
  });
  if (!essays.length) return { graded: [], error: null };

  let error = null;
  // بالتوازي: أسئلة الاختبار الواحد قليلة (وحدات مش مئات)، والتسلسل كان هيخلي الطالب
  // مستني ثانية × عدد الأسئلة قدام شاشة تسليم واقفة
  const graded = await Promise.all(essays.map(async (answer) => {
    const question = questions.get(answer.question_id);
    const studentAnswer = (answer.essay_text || '').trim();
    // إجابة فاضية مش محتاجة نموذج — صفر، وبنوفّر النداء
    if (!studentAnswer) {
      return { question_id: answer.question_id, verdict: 'incorrect', score_ratio: 0, reason: 'ساب السؤال فاضي', provider: null };
    }
    try {
      const grade = await gradeEssayAnswer({
        question: questionTextForGrading(question),
        referenceAnswer: question.reference_answer || '',
        gradingNotes: question.grading_notes || '',
        studentAnswer,
      });
      return { question_id: answer.question_id, ...grade };
    } catch (err) {
      console.error(`❌ Failed to grade essay answer for question ${answer.question_id}:`, err.message);
      error = err.message;
      return null;
    }
  }));

  return { graded: graded.filter(Boolean), error };
}

// بتشتغل على محاولة واحدة وبترجع { score, max_score, grading_status }. آمنة للنداء أكتر من
// مرة: لو المحاولة اتسلّمت خلاص بترجع نتيجتها من غير ما تصحّح تاني ولا تنادي النموذج.
// force بيكسر الحماية دي — بتتستخدم في إعادة تصحيح اختبار كامل بعد تعديل إجابة مرجعية
async function finalizeAttempt(attemptId, { late = false, force = false } = {}) {
  const attemptResult = await pool.query(
    `SELECT a.id, a.quiz_id, a.submitted_at, a.score, a.max_score, a.grading_status
     FROM quiz_attempts a WHERE a.id = $1`, [attemptId]);
  const attempt = attemptResult.rows[0];
  if (!attempt) throw new Error('المحاولة مش موجودة');
  if (!force && attempt.submitted_at && attempt.grading_status !== 'partial') {
    return { score: Number(attempt.score), max_score: Number(attempt.max_score), grading_status: attempt.grading_status };
  }

  const [questionsResult, answersResult] = await Promise.all([
    pool.query(
      // **نص الأب بيتجاب مع الفرع.** "اذكر اتنين منهم" مالهاش أي معنى لوحدها — النموذج
      // لازم يشوف رأس السؤال عشان يحكم على إجابة الفرع
      `SELECT q.id, q.kind, q.text, q.points, q.correct_option, q.reference_answer,
              q.grading_notes, q.label, p.text AS parent_text
       FROM quiz_questions q
       LEFT JOIN quiz_questions p ON p.id = q.parent_id
       WHERE q.quiz_id = $1`, [attempt.quiz_id]),
    pool.query('SELECT question_id, selected_option, essay_text, graded_by, awarded_points FROM quiz_answers WHERE attempt_id = $1', [attemptId]),
  ]);

  const questions = new Map(questionsResult.rows.map((row) => [row.id, row]));
  const answers = answersResult.rows;
  // درجة الاختبار = مجموع كل الأسئلة، مش بس اللي جاوبها. السؤال اللي ساكته صفر
  const maxScore = questionsResult.rows.reduce((sum, row) => sum + Number(row.points), 0);

  // الاختياري: مقارنة فهرس مباشرة، مفيش نموذج ولا احتمال فشل
  for (const answer of answers) {
    const question = questions.get(answer.question_id);
    if (!question || question.kind !== 'mcq') continue;
    // الموظف عدّل الدرجة بإيده؟ تفضل زي ما هي — إعادة التصحيح مابتمسحش حكم بني آدم
    if (answer.graded_by === 'staff') continue;
    const correct = question.correct_option !== null && Number(answer.selected_option) === Number(question.correct_option);
    await pool.query(
      `UPDATE quiz_answers SET is_correct = $1, awarded_points = $2, graded_by = 'auto', graded_at = NOW()
       WHERE attempt_id = $3 AND question_id = $4`,
      [correct, correct ? Number(question.points) : 0, attemptId, answer.question_id]
    );
  }

  // awarded_points IS NULL شرط مقصود: النداء التاني (زرار "صحّح دلوقتي" بعد فشل) بيصحّح
  // اللي فشل بس، مابيرجعش يدفع تمن الأسئلة اللي نجحت من أول مرة
  const essayAnswers = answers.filter((answer) => {
    const question = questions.get(answer.question_id);
    return question && question.kind === 'essay'
      && answer.graded_by !== 'staff' && answer.awarded_points === null;
  });
  const { graded, error } = await gradeEssays(essayAnswers, questions);

  for (const grade of graded) {
    const question = questions.get(grade.question_id);
    await pool.query(
      `UPDATE quiz_answers
       SET is_correct = $1, awarded_points = $2, ai_verdict = $3, ai_reason = $4, ai_provider = $5,
           graded_by = 'auto', graded_at = NOW()
       WHERE attempt_id = $6 AND question_id = $7`,
      [grade.verdict === 'correct', Number((Number(question.points) * grade.score_ratio).toFixed(2)),
        grade.verdict, grade.reason, grade.provider, attemptId, grade.question_id]
    );
  }

  const totalResult = await pool.query(
    'SELECT COALESCE(SUM(awarded_points), 0) AS total FROM quiz_answers WHERE attempt_id = $1', [attemptId]);
  const score = Number(totalResult.rows[0].total);
  // partial = فيه سؤال مقالي لسه من غير درجة. بيبان في اللوحة كتنبيه للموظف
  const ungraded = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_answers WHERE attempt_id = $1 AND awarded_points IS NULL', [attemptId]);
  const status = ungraded.rows[0].count > 0 ? 'partial' : 'graded';

  await pool.query(
    `UPDATE quiz_attempts
     SET submitted_at = COALESCE(submitted_at, NOW()), score = $1, max_score = $2,
         grading_status = $3, grading_error = $4, is_late = is_late OR $5
     WHERE id = $6`,
    [score, maxScore, status, error, late, attemptId]
  );

  return { score, max_score: maxScore, grading_status: status };
}

// إعادة حساب مجموع المحاولة بعد ما موظف يعدّل درجة سؤال — من غير أي نداء للنموذج
async function recalculateAttempt(attemptId) {
  const totalResult = await pool.query(
    'SELECT COALESCE(SUM(awarded_points), 0) AS total FROM quiz_answers WHERE attempt_id = $1', [attemptId]);
  const ungraded = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_answers WHERE attempt_id = $1 AND awarded_points IS NULL', [attemptId]);
  const status = ungraded.rows[0].count > 0 ? 'partial' : 'graded';
  // الموظف عدّل درجة والمحاولة لسه في الطابور؟ الحالة تفضل زي ما هي عشان الوظيفة
  // ماتفوّتهاش وتسيبها من غير تصحيح
  await pool.query(
    `UPDATE quiz_attempts SET score = $1,
            grading_status = CASE WHEN grading_status IN ('queued', 'regrading') THEN grading_status ELSE $2 END
     WHERE id = $3`,
    [Number(totalResult.rows[0].total), status, attemptId]);
  return { score: Number(totalResult.rows[0].total), grading_status: status };
}

// ---------- إعادة تصحيح اختبار كامل ----------
//
// **ليه طابور مش تصحيح فوري:** اختبار فيه ١٠٠ طالب × ٥ أسئلة مقالية = ٥٠٠ نداء للنموذج،
// يعني الطلب هيفضل مفتوح أكتر من عشرين دقيقة ويقع على أول timeout. فالمسار بيعلّم المحاولات
// وبيرجع فورًا، والتصحيح بيمشي في الخلفية وبيكمّل من مكانه لو السيرفر اتقفل في النص.
//
// **درجات الموظف مابتتلمسش.** أي سؤال حطّ فيه درجة بإيده بيفضل زي ما هو — إعادة التصحيح
// بتصلّح شغل النموذج، مش بتلغي حكم بني آدم.
async function queueQuizRegrade(quizId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // تصفير درجات النموذج للمقالي بس: الاختياري بيتحسب من الفهرس على طول جوه finalizeAttempt
    // ومش محتاج نداء، فتصفيره كان هيخسّرنا حاجة من غير فايدة
    const reset = await client.query(
      `UPDATE quiz_answers an
       SET awarded_points = NULL, is_correct = NULL, ai_verdict = NULL, ai_reason = NULL, ai_provider = NULL
       FROM quiz_attempts a, quiz_questions q
       WHERE an.attempt_id = a.id AND an.question_id = q.id
         AND a.quiz_id = $1 AND a.submitted_at IS NOT NULL
         AND q.kind = 'essay' AND an.graded_by <> 'staff'`, [quizId]);
    // المحاولات اللي لسه بتتحل مابتدخلش الطابور — هتتصحّح بالمرجع الجديد وقت التسليم عادي
    const queued = await client.query(
      `UPDATE quiz_attempts SET grading_status = 'regrading', grading_error = NULL
       WHERE quiz_id = $1 AND submitted_at IS NOT NULL RETURNING id`, [quizId]);
    await client.query('COMMIT');
    return { attempts: queued.rowCount, answers_reset: reset.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// حالتين بيدخلوا نفس الطابور: 'queued' (طالب سلّم لسه) و'regrading' (موظف طلب إعادة
// تصحيح). التصحيح نفسه واحد، فالطابور واحد
const QUEUED_STATUSES = ['queued', 'regrading'];

// **كام محاولة بالتوازي.** المحاولة الواحدة بتصحّح كل أسئلتها المقالية بالتوازي، فامتحان
// ٢٥ سؤال مقالي × ٤ محاولات = ١٠٠ نداء متزامن للنموذج. ده الرقم اللي بيتضبط عليه المعدل:
// أعلى منه بيبقى أسرع لكن أقرب لحد المزوّد (429)، وأقل منه بيبقى أأمن وأبطأ.
// **الحساب: ٥٠٠٠ طالب ÷ (٤ محاولات كل ~٣ ثواني) ≈ ساعة.**
// **كام ورقة بالتوازي.** كان متغيّر بيئة بس — يعني تغييره محتاج SSH وتعديل ملف
// وrestart، وده مقفول على صاحب المشروع وقت ما يكون محتاجه بالظبط (نص امتحان بآلاف
// الطلاب). بقى إعداد في القاعدة بيتقرا مع كل دورة طابور، والمتغيّر البيئي بقى
// الافتراضي لو الصف مش موجود.
//
// الرقم بيتضرب في عدد الأسئلة المقالية: امتحان ٢٥ سؤال × ٤ أوراق = ١٠٠ نداء متزامن.
// أعلى = أسرع وأقرب لـ429 من المزوّد، وأقل = أبطأ وأأمن
const DEFAULT_CONCURRENCY = Number(process.env.QUIZ_GRADING_CONCURRENCY) || 4;
const MAX_CONCURRENCY = 32;

async function attemptConcurrency() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM settings WHERE key = 'quiz_grading_concurrency'");
    const value = Number(rows[0]?.value);
    if (Number.isFinite(value) && value >= 1) return Math.min(Math.floor(value), MAX_CONCURRENCY);
  } catch (error) {
    // إعداد مش مقروء مايوقفش التصحيح — بنكمّل على الافتراضي
    console.error('❌ Failed to read the grading concurrency setting:', error.message);
  }
  return DEFAULT_CONCURRENCY;
}

async function gradeOne(attemptId) {
  try {
    await finalizeAttempt(attemptId, { force: true });
    return true;
  } catch (error) {
    // بتطلع من الطابور بحالة "محتاجة مراجعتك" مش بتفضل فيه — لو سيبناها كانت هتفشل كل
    // دقيقتين للأبد. الموظف بيشوفها في اللوحة ومعاها زرار "أعد التصحيح الآلي"
    console.error(`❌ Failed to grade quiz attempt #${attemptId}:`, error.message);
    await pool.query(
      `UPDATE quiz_attempts SET grading_status = 'partial', grading_error = $1 WHERE id = $2`,
      [error.message, attemptId]).catch(() => {});
    return false;
  }
}

// بتاخد دفعة من الطابور وتصحّحها. بيتنداها التسليم بعد ما يرد (عشان الطالب الوحيد ياخد
// درجته فورًا) وكمان الكرون (عشان يصرّف الباقي ويكمّل لو السيرفر اتقفل في النص)
async function processRegradeQueue(limit = 10) {
  const { rows } = await pool.query(
    `SELECT id FROM quiz_attempts WHERE grading_status = ANY($1) ORDER BY submitted_at, id LIMIT $2`,
    [QUEUED_STATUSES, limit]);

  let done = 0;
  // بيتقرا مرة لكل دورة طابور مش لكل ورقة: الدورة بتحصل مرة في الدقيقة، فتغيير الأدمن
  // بيسري في الدورة اللي بعده على طول من غير أي حمل يذكر
  const concurrency = await attemptConcurrency();
  // على دفعات: التسلسل الكامل بطيء جدًا لخمس آلاف ورقة، والتوازي الكامل بيولّع حد
  // المعدل عند المزوّد
  for (let index = 0; index < rows.length; index += concurrency) {
    const slice = rows.slice(index, index + concurrency);
    const outcomes = await Promise.all(slice.map((row) => gradeOne(row.id)));
    done += outcomes.filter(Boolean).length;
  }

  const left = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_attempts WHERE grading_status = ANY($1)',
    [QUEUED_STATUSES]);
  return { processed: done, remaining: left.rows[0].count };
}

async function queueLength() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_attempts WHERE grading_status = ANY($1)',
    [QUEUED_STATUSES]);
  return rows[0].count;
}

module.exports = {
  finalizeAttempt, recalculateAttempt, queueQuizRegrade, processRegradeQueue, queueLength,
  attemptConcurrency, MAX_CONCURRENCY,
};
