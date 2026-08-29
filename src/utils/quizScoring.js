const pool = require('../config/db');
const { gradeEssayAnswer } = require('./quizGrading');

// ---------- إنهاء المحاولة وحساب الدرجة ----------
//
// مشترك بين تلات مسارات: الطالب بيسلّم بنفسه، والوقت خلص وهو قافل الصفحة (jobs/quizFinalizer)،
// والموظف بيضغط "صحّح دلوقتي". التلاتة بيعملوا نفس الحاجة بالظبط فلازم يبقوا كود واحد.

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
        question: question.text,
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
// مرة: لو المحاولة اتسلّمت خلاص بترجع نتيجتها من غير ما تصحّح تاني ولا تنادي النموذج
async function finalizeAttempt(attemptId, { late = false } = {}) {
  const attemptResult = await pool.query(
    `SELECT a.id, a.quiz_id, a.submitted_at, a.score, a.max_score, a.grading_status
     FROM quiz_attempts a WHERE a.id = $1`, [attemptId]);
  const attempt = attemptResult.rows[0];
  if (!attempt) throw new Error('المحاولة مش موجودة');
  if (attempt.submitted_at && attempt.grading_status !== 'partial') {
    return { score: Number(attempt.score), max_score: Number(attempt.max_score), grading_status: attempt.grading_status };
  }

  const [questionsResult, answersResult] = await Promise.all([
    pool.query(
      `SELECT id, kind, text, points, correct_option, reference_answer, grading_notes
       FROM quiz_questions WHERE quiz_id = $1`, [attempt.quiz_id]),
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
  await pool.query('UPDATE quiz_attempts SET score = $1, grading_status = $2 WHERE id = $3',
    [Number(totalResult.rows[0].total), status, attemptId]);
  return { score: Number(totalResult.rows[0].total), grading_status: status };
}

module.exports = { finalizeAttempt, recalculateAttempt };
