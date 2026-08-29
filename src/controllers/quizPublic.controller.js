const crypto = require('crypto');
const pool = require('../config/db');
const { finalizeAttempt } = require('../utils/quizScoring');

// ---------- صفحة الاختبار للطالب ----------
//
// صفحة عامة من غير تسجيل دخول — نفس نمط /r/:token و /me/:token، والهوية بتتحدد جوه
// الصفحة برقم التليفون.
//
// **الرابط مش وسيلة الحماية هنا.** الاختبار بيتبعت لمئات الطلاب في رسالة واحدة وبيتنشر
// بينهم في دقايق، فالتوكن الطويل كان بيدّي إحساس زائف بالسرّية. اللي بيحمي فعلًا: قفل
// الاختبار (is_open)، ومحاولة واحدة لكل طالب، وإن الأسئلة مابتتبعتش قبل الدخول بالرقم.
//
// **الأسئلة مابتتحقنش في الـ HTML.** الصفحة بتتحمّل ببوابة رقم التليفون بس، والأسئلة بتيجي
// في نداء تاني بعد ما المحاولة تتفتح. لولا كده كان أي حد يفتح مصدر الصفحة يقرا الأسئلة
// (والإجابات الصح مع الاختياري) من غير ما المؤقت يبدأ أصلًا.

// آخر ١٠ أرقام بس — نفس تطبيع bot/handlers/studentReport.js بالحرف. التليفون متخزّن على
// المنصة بأشكال مختلفة (+٢٠، ٠٠٢٠، من غير صفر) والطالب بيكتبه بشكل تالت
function normalizePhone(raw) {
  // الطالب بيكتب من كيبورد عربي غالبًا فبيبعت ٠١٠... مش 010...
  const ascii = String(raw || '').replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
  const digits = ascii.replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// الرابط بياخد شكلين: المختصر (/q/bio-1) والتوكن الطويل (/q/5bf5...). الاتنين على نفس
// الاختبار عن قصد — الروابط اللي اتبعتت للطلاب قبل ما المختصر يتضاف لازم تفضل شغّالة.
// المقارنة على المختصر بتتجاهل حالة الحروف لأن الطالب بيكتبه بإيده
async function loadQuizByRef(ref) {
  const { rows } = await pool.query(
    `SELECT id, title, description, time_limit_minutes, is_open, show_score_to_student
     FROM quizzes WHERE LOWER(slug) = LOWER($1) OR token = $1`, [ref]);
  return rows[0] || null;
}

// الأسئلة زي ما الطالب لازم يشوفها: من غير correct_option ولا reference_answer. الحذف هنا
// مش في الواجهة — أي حقل بيوصل المتصفح بيتقري
async function loadQuestionsForStudent(quizId) {
  const { rows } = await pool.query(
    `SELECT id, kind, text, points, options FROM quiz_questions
     WHERE quiz_id = $1 ORDER BY position, id`, [quizId]);
  return rows.map((row) => ({
    id: row.id, kind: row.kind, text: row.text, points: Number(row.points),
    options: row.kind === 'mcq' ? (row.options || []) : [],
  }));
}

async function renderQuiz(req, res) {
  const quiz = await loadQuizByRef(req.params.ref);
  if (!quiz) return res.status(404).render('report-not-found');
  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_questions WHERE quiz_id = $1', [quiz.id]);
  res.render('quiz', {
    quiz: {
      title: quiz.title,
      description: quiz.description,
      time_limit_minutes: quiz.time_limit_minutes,
      is_open: quiz.is_open,
      question_count: countResult.rows[0].count,
    },
  });
}

// بترجع شكل موحّد للواجهة في كل الحالات: محاولة جديدة، استكمال محاولة مفتوحة، أو نتيجة
// محاولة اتسلّمت خلاص
function attemptPayload(attempt, quiz, questions) {
  return {
    state: attempt.submitted_at ? 'submitted' : 'open',
    attempt_key: attempt.submitted_at ? null : attempt.attempt_key,
    student_name: attempt.student_name,
    deadline_at: attempt.deadline_at,
    questions: attempt.submitted_at ? [] : questions,
    saved: attempt.saved || {},
    score: attempt.submitted_at && quiz.show_score_to_student ? Number(attempt.score) : null,
    max_score: attempt.submitted_at && quiz.show_score_to_student ? Number(attempt.max_score) : null,
    // الدرجة اتحجبت بقرار من الموظف مش لأنها لسه بتتحسب — الفرق ده لازم يوصل للطالب
    score_hidden: Boolean(attempt.submitted_at && !quiz.show_score_to_student),
  };
}

async function loadSavedAnswers(attemptId) {
  const { rows } = await pool.query(
    'SELECT question_id, selected_option, essay_text FROM quiz_answers WHERE attempt_id = $1', [attemptId]);
  return Object.fromEntries(rows.map((row) => [row.question_id, {
    selected_option: row.selected_option, essay_text: row.essay_text,
  }]));
}

// ---------- الدخول للاختبار ----------
// بيتنادى بالتليفون، وممكن يترد عليه بطلب اختيار (رقم مشترك بين إخوات) أو طلب اسم (رقم
// مش على المنصة). الحالتين بيرجعوا للواجهة عشان تسأل، والنداء بيتعاد بنفس التليفون + الزيادة
async function startAttempt(req, res) {
  const quiz = await loadQuizByRef(req.params.ref);
  if (!quiz) return res.status(404).json({ error: 'الاختبار مش موجود' });

  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'اكتب رقم موبايلك صح (١١ رقم)' });

  const pickedStudentId = req.body?.student_id ? Number(req.body.student_id) : null;
  const typedName = String(req.body?.name || '').trim();

  const matches = await pool.query(
    `SELECT tafra_student_id, name FROM tafra_students
     WHERE RIGHT(REGEXP_REPLACE(translate(phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 10) = $1
     ORDER BY name`, [phone]);

  let studentId = null;
  let studentName = null;
  if (matches.rows.length === 1) {
    studentId = Number(matches.rows[0].tafra_student_id);
    studentName = matches.rows[0].name;
  } else if (matches.rows.length > 1) {
    // ٦٩ رقم على المنصة متكرر بين إخوات. التخمين هنا يعني إن الامتحان يتحسب للأخ الغلط،
    // فالطالب هو اللي بيختار — الأسامي دي هو عارفها أصلًا لأنها بيت واحد
    const picked = matches.rows.find((row) => Number(row.tafra_student_id) === pickedStudentId);
    if (!picked) {
      return res.json({
        needs_pick: true,
        students: matches.rows.map((row) => ({ id: Number(row.tafra_student_id), name: row.name })),
      });
    }
    studentId = Number(picked.tafra_student_id);
    studentName = picked.name;
  } else {
    // الرقم مش على المنصة: ٢٤٪ من اللي بيكلّموا البوت مش مربوطين بحساب. منعهم من الامتحان
    // أسوأ من صف محتاج ربط يدوي، فبياخد اسمه ويدخل والموظف بيشوفه متعلّم "مش مطابق"
    if (!typedName) return res.json({ needs_name: true });
    studentName = typedName;
  }

  // محاولة موجودة؟ الرجوع ليها أهم من منعها: الطالب ممكن يكون قفل الصفحة بالغلط، والمؤقت
  // بيفضل ماشي من وقت الدخول الأول فمفيش استفادة من إعادة الفتح
  const existing = await pool.query(
    `SELECT id, attempt_key, student_name, deadline_at, submitted_at, score, max_score
     FROM quiz_attempts
     WHERE quiz_id = $1 AND phone = $2 AND COALESCE(tafra_student_id, 0) = $3`,
    [quiz.id, phone, studentId || 0]);

  if (existing.rows.length) {
    const attempt = existing.rows[0];
    // الوقت خلص وهو قافل الصفحة: بنقفلها ونصحّح اللي كان محفوظ بدل ما تفضل مفتوحة للأبد
    if (!attempt.submitted_at && attempt.deadline_at && new Date(attempt.deadline_at) <= new Date()) {
      await finalizeAttempt(attempt.id, { late: false });
      const refreshed = await pool.query(
        'SELECT id, attempt_key, student_name, deadline_at, submitted_at, score, max_score FROM quiz_attempts WHERE id = $1',
        [attempt.id]);
      return res.json(attemptPayload(refreshed.rows[0], quiz, []));
    }
    if (attempt.submitted_at) return res.json(attemptPayload(attempt, quiz, []));
    if (!quiz.is_open) return res.status(403).json({ error: 'الاختبار اتقفل' });
    const questions = await loadQuestionsForStudent(quiz.id);
    attempt.saved = await loadSavedAnswers(attempt.id);
    return res.json(attemptPayload(attempt, quiz, questions));
  }

  if (!quiz.is_open) return res.status(403).json({ error: 'الاختبار اتقفل' });

  const attemptKey = crypto.randomBytes(24).toString('hex');
  const deadline = quiz.time_limit_minutes
    ? new Date(Date.now() + quiz.time_limit_minutes * 60 * 1000) : null;
  let created;
  try {
    created = await pool.query(
      `INSERT INTO quiz_attempts (quiz_id, tafra_student_id, student_name, phone, attempt_key, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, attempt_key, student_name, deadline_at, submitted_at, score, max_score`,
      [quiz.id, studentId, studentName, phone, attemptKey, deadline]);
  } catch (error) {
    // سباق: نفس الطالب فتح الرابط في تابين في نفس اللحظة. الفهرس الفريد بيمسكها،
    // وبنرجع للمحاولة اللي كسبت بدل ما نرمي خطأ في وش الطالب
    if (error.code !== '23505') throw error;
    const raced = await pool.query(
      `SELECT id, attempt_key, student_name, deadline_at, submitted_at, score, max_score
       FROM quiz_attempts WHERE quiz_id = $1 AND phone = $2 AND COALESCE(tafra_student_id, 0) = $3`,
      [quiz.id, phone, studentId || 0]);
    created = raced;
  }

  const attempt = created.rows[0];
  attempt.saved = await loadSavedAnswers(attempt.id);
  const questions = await loadQuestionsForStudent(quiz.id);
  res.json(attemptPayload(attempt, quiz, questions));
}

// المحاولة بتتعرف بمفتاحها مش بالتليفون: الرقم مش سر، والمفتاح بيتولّد مرة واحدة ومابيتعرضش
async function loadOpenAttempt(ref, attemptKey) {
  const { rows } = await pool.query(
    `SELECT a.id, a.quiz_id, a.submitted_at, a.deadline_at, q.is_open, q.show_score_to_student, q.title
     FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
     WHERE (LOWER(q.slug) = LOWER($1) OR q.token = $1) AND a.attempt_key = $2`, [ref, attemptKey]);
  return rows[0] || null;
}

// حفظ تلقائي كل شوية وقت ما الطالب بيكتب. **بيتخزّن من غير تصحيح** — التصحيح بيحصل مرة
// واحدة عند التسليم. من غير الحفظ ده، أي قفل للتاب في امتحان بمؤقت كان بيساوي صفر
async function saveProgress(req, res) {
  const attempt = await loadOpenAttempt(req.params.ref, req.body?.attempt_key);
  if (!attempt) return res.status(404).json({ error: 'المحاولة مش موجودة' });
  if (attempt.submitted_at) return res.status(409).json({ error: 'الاختبار اتسلّم خلاص' });

  await persistAnswers(attempt, req.body?.answers);
  res.json({ ok: true });
}

// بتكتب الإجابات بس — من غير أي درجة. الفهرس الفريد (attempt_id, question_id) بيخلي
// الحفظ المتكرر تحديث مش صفوف جديدة
async function persistAnswers(attempt, answers) {
  if (!Array.isArray(answers) || !answers.length) return;
  const { rows: questions } = await pool.query(
    'SELECT id, kind FROM quiz_questions WHERE quiz_id = $1', [attempt.quiz_id]);
  const kinds = new Map(questions.map((row) => [row.id, row.kind]));

  for (const answer of answers) {
    const questionId = Number(answer?.question_id);
    // سؤال من اختبار تاني (أو مش موجود) بيتتجاهل — الواجهة مش مصدر ثقة
    if (!kinds.has(questionId)) continue;
    const isMcq = kinds.get(questionId) === 'mcq';
    const selected = isMcq && answer.selected_option !== null && answer.selected_option !== undefined
      ? Number(answer.selected_option) : null;
    const essay = !isMcq ? String(answer.essay_text || '').slice(0, 20000) : null;
    await pool.query(
      `INSERT INTO quiz_answers (attempt_id, question_id, selected_option, essay_text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (attempt_id, question_id) DO UPDATE
       SET selected_option = EXCLUDED.selected_option, essay_text = EXCLUDED.essay_text`,
      [attempt.id, questionId, Number.isFinite(selected) ? selected : null, essay]);
  }
}

async function submitAttempt(req, res) {
  const attempt = await loadOpenAttempt(req.params.ref, req.body?.attempt_key);
  if (!attempt) return res.status(404).json({ error: 'المحاولة مش موجودة' });
  if (attempt.submitted_at) return res.status(409).json({ error: 'الاختبار اتسلّم خلاص' });

  await persistAnswers(attempt, req.body?.answers);
  // دقيقة سماح: التسليم التلقائي بيتنفّذ في المتصفح فبيوصل السيرفر متأخر ثواني، والشبكة
  // البطيئة مش ذنب الطالب. أبعد من كده بيتسجّل متأخر ويبان للموظف
  const late = Boolean(attempt.deadline_at && Date.now() > new Date(attempt.deadline_at).getTime() + 60 * 1000);

  const result = await finalizeAttempt(attempt.id, { late });
  res.json({
    state: 'submitted',
    score: attempt.show_score_to_student ? result.score : null,
    max_score: attempt.show_score_to_student ? result.max_score : null,
    score_hidden: !attempt.show_score_to_student,
  });
}

module.exports = { renderQuiz, startAttempt, saveProgress, submitAttempt, normalizePhone };
