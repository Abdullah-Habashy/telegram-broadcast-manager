const crypto = require('crypto');
const pool = require('../config/db');
const { finalizeAttempt, processRegradeQueue } = require('../utils/quizScoring');

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
    `SELECT id, title, description, time_limit_minutes, is_open,
            show_score_to_student, show_answers_to_student
     FROM quizzes WHERE LOWER(slug) = LOWER($1) OR token = $1`, [ref]);
  return rows[0] || null;
}

// الأسئلة زي ما الطالب لازم يشوفها: من غير correct_option ولا reference_answer. الحذف هنا
// مش في الواجهة — أي حقل بيوصل المتصفح بيتقري.
//
// الشكل شجرة: السؤال اللي ليه رأس بيرجع kind='group' ومعاه parts، والسؤال العادي بيرجع
// لوحده. الأب مالوش خانة إجابة ولا درجة — هو عنوان للفروع
async function loadQuestionsForStudent(quizId) {
  const { rows } = await pool.query(
    `SELECT q.id, q.parent_id, q.label, q.kind, q.text, q.points, q.options, q.image_path
     FROM quiz_questions q
     LEFT JOIN quiz_questions p ON p.id = q.parent_id
     WHERE q.quiz_id = $1
     ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`,
    [quizId]);

  const shape = (row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label || null,
    text: row.text,
    image: row.image_path || null,
    points: Number(row.points),
    // الاختيار بقى {text, image}. الصف القديم النص بيتحوّل هنا عشان الواجهة تشوف شكل واحد
    options: row.kind === 'mcq'
      ? (row.options || []).map((option) => (typeof option === 'string'
        ? { text: option, image: null }
        : { text: String(option?.text || ''), image: option?.image || null }))
      : [],
  });

  const parents = [];
  const byId = new Map();
  for (const row of rows) {
    const question = shape(row);
    if (row.parent_id) {
      const parent = byId.get(row.parent_id);
      if (parent) parent.parts.push(question);
      continue;
    }
    question.parts = [];
    byId.set(row.id, question);
    parents.push(question);
  }
  return parents;
}

// ---------- تصحيح الورقة للطالب ----------
//
// **بيتبعت بعد التسليم والتصحيح بس.** الاستعلام ده هو استعلام مراجعة المحاولة عند الموظف
// بالحرف (quizzes.controller.js → getAttempt) — نفس الجوينات ونفس الترتيب — عشان الطالب
// يشوف نفس الورقة اللي الموظف شايفها، مايبقاش فيه نسختين للتصحيح تفترقوا مع أول تعديل.
//
// **الفرق الوحيد: اللي بيخص الشغل الداخلي مابيخرجش.** اسم الموظف اللي عدّل الدرجة، والمزوّد
// اللي صحّح، وتعليمات التصحيح — كلها مالهاش معنى للطالب. نفس قاعدة صفحة /me/:token:
// الطالب بياخد اللي بيفيده هو، مش سجل إداري.
//
// وسبب النموذج (ai_reason) بيتبعت **لو النموذج هو اللي حاطط الدرجة**. لو موظف عدّلها بإيده،
// السبب القديم بقى بيناقض الدرجة المعروضة — والطالب اللي بيقرا "إجابتك ناقصة" جنب الدرجة
// الكاملة بيفتح تذكرة، فبيتشال
async function loadReviewForAttempt(attemptId, quizId) {
  const { rows } = await pool.query(
    `SELECT q.id AS question_id, q.parent_id, q.label, q.kind, q.text, q.points,
            q.options, q.correct_option, q.reference_answer, q.image_path,
            (an.id IS NOT NULL) AS answered,
            an.selected_option, an.essay_text, an.awarded_points, an.is_correct,
            an.ai_verdict, an.ai_reason, an.graded_by
     FROM quiz_questions q
     LEFT JOIN quiz_questions p ON p.id = q.parent_id
     LEFT JOIN quiz_answers an ON an.question_id = q.id AND an.attempt_id = $1
     WHERE q.quiz_id = $2
     ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`,
    [attemptId, quizId]);

  return rows.map((row) => ({
    question_id: row.question_id,
    kind: row.kind,
    label: row.label || null,
    text: row.text,
    image: row.image_path || null,
    points: Number(row.points),
    is_part: row.parent_id !== null,
    // نفس تطبيع الاختيارات في loadQuestionsForStudent — الصف القديم نصوص والجديد كائنات
    options: row.kind === 'mcq'
      ? (row.options || []).map((option) => (typeof option === 'string'
        ? { text: option, image: null }
        : { text: String(option?.text || ''), image: option?.image || null }))
      : [],
    correct_option: row.kind === 'mcq' ? row.correct_option : null,
    reference_answer: row.kind === 'essay' ? row.reference_answer : null,
    // **فرق بين "ماجاوبش" و"مالوش صف أصلًا".** الصفحة بتبعت صف لكل سؤال حتى لو فاضي،
    // فغياب الصف معناه سؤال اتضاف للاختبار بعد ما الطالب سلّم — ده مالوش تصحيح، مش غلط
    answered: row.answered,
    selected_option: row.selected_option,
    essay_text: row.essay_text,
    awarded_points: row.awarded_points === null ? null : Number(row.awarded_points),
    is_correct: row.is_correct,
    verdict: row.ai_verdict,
    reason: row.graded_by === 'auto' ? row.ai_reason : null,
  }));
}

// التصحيح بيتحمّل لما يكون فيه تصحيح فعلًا: المحاولة اتسلّمت، والتصحيح خلص (graded) أو خلص
// وفيه سؤال مستني موظف (partial). و**queued/regrading مابيرجّعوش حاجة** — الدرجات وقتها
// نص مكتوبة، والطالب اللي شاف "غلط" وبعد دقيقة بقت "صح" بيفقد الثقة في الورقة كلها
async function reviewIfReady(attempt, quiz) {
  if (!attempt.submitted_at || !quiz.show_answers_to_student) return null;
  if (attempt.grading_status !== 'graded' && attempt.grading_status !== 'partial') return null;
  return loadReviewForAttempt(attempt.id, quiz.id);
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
function attemptPayload(attempt, quiz, questions, review) {
  // اتسلّمت ولسه في الطابور: 'grading' مش 'submitted' — الصفحة وقتها بتوري "بنصحّح"
  // وتسأل عن الدرجة، بدل ما توري صفر على إنه نتيجته
  const grading = Boolean(attempt.submitted_at)
    && (attempt.grading_status === 'queued' || attempt.grading_status === 'regrading');
  return {
    state: grading ? 'grading' : attempt.submitted_at ? 'submitted' : 'open',
    // بيفضل موجود في حالة grading عشان الصفحة تقدر تسأل عن الدرجة بيه
    attempt_key: grading || !attempt.submitted_at ? attempt.attempt_key : null,
    student_name: attempt.student_name,
    deadline_at: attempt.deadline_at,
    questions: attempt.submitted_at ? [] : questions,
    saved: attempt.saved || {},
    score: attempt.submitted_at && quiz.show_score_to_student ? Number(attempt.score) : null,
    max_score: attempt.submitted_at && quiz.show_score_to_student ? Number(attempt.max_score) : null,
    // الدرجة اتحجبت بقرار من الموظف مش لأنها لسه بتتحسب — الفرق ده لازم يوصل للطالب
    score_hidden: Boolean(attempt.submitted_at && !quiz.show_score_to_student),
    // ورقة التصحيح: سؤال سؤال، إجابته والصح. null = مش متاحة (لسه بتتصحّح أو الموظف قافلها)
    review: review || null,
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
    `SELECT id, attempt_key, student_name, deadline_at, submitted_at, score, max_score, grading_status
     FROM quiz_attempts
     WHERE quiz_id = $1 AND phone = $2 AND COALESCE(tafra_student_id, 0) = $3`,
    [quiz.id, phone, studentId || 0]);

  if (existing.rows.length) {
    const attempt = existing.rows[0];
    // الوقت خلص وهو قافل الصفحة: بنقفلها ونصحّح اللي كان محفوظ بدل ما تفضل مفتوحة للأبد
    if (!attempt.submitted_at && attempt.deadline_at && new Date(attempt.deadline_at) <= new Date()) {
      await finalizeAttempt(attempt.id, { late: false });
      const refreshed = await pool.query(
        'SELECT id, attempt_key, student_name, deadline_at, submitted_at, score, max_score, grading_status FROM quiz_attempts WHERE id = $1',
        [attempt.id]);
      return res.json(attemptPayload(refreshed.rows[0], quiz, [],
        await reviewIfReady(refreshed.rows[0], quiz)));
    }
    // **ده المسار اللي الطالب بيرجع بيه يشوف تصحيحه**: نفس الرابط ونفس الرقم في أي وقت.
    // مافيش محاولة تانية بتتفتح — الفهرس الفريد بيمنعها — فالرجوع بيوري الورقة بس
    if (attempt.submitted_at) {
      return res.json(attemptPayload(attempt, quiz, [], await reviewIfReady(attempt, quiz)));
    }
    if (!quiz.is_open) return res.status(403).json({ error: 'الاختبار اتقفل' });

    // محاولة اتفتحت له من تاني: الموظف سابها من غير ميعاد عن قصد، والمؤقت بيبدأ من
    // اللحظة اللي بيرجع فيها هو — مش من لحظة ما الموظف ضغط الزرار. الشرط في UPDATE
    // بيمنع دخولين في نفس اللحظة من إنهم يكتبوا ميعادين مختلفين
    if (!attempt.deadline_at && quiz.time_limit_minutes) {
      const fresh = new Date(Date.now() + quiz.time_limit_minutes * 60 * 1000);
      const timed = await pool.query(
        `UPDATE quiz_attempts SET deadline_at = $1, started_at = NOW()
         WHERE id = $2 AND deadline_at IS NULL
         RETURNING deadline_at`, [fresh, attempt.id]);
      attempt.deadline_at = timed.rows.length ? timed.rows[0].deadline_at : attempt.deadline_at;
    }

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
       RETURNING id, attempt_key, student_name, deadline_at, submitted_at, score, max_score, grading_status`,
      [quiz.id, studentId, studentName, phone, attemptKey, deadline]);
  } catch (error) {
    // سباق: نفس الطالب فتح الرابط في تابين في نفس اللحظة. الفهرس الفريد بيمسكها،
    // وبنرجع للمحاولة اللي كسبت بدل ما نرمي خطأ في وش الطالب
    if (error.code !== '23505') throw error;
    const raced = await pool.query(
      `SELECT id, attempt_key, student_name, deadline_at, submitted_at, score, max_score, grading_status
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
// الحفظ المتكرر تحديث مش صفوف جديدة.
//
// **استعلام واحد لكل الأسئلة، مش استعلام لكل سؤال.** النسخة الأولى كانت بتعمل استعلام
// للأنواع + استعلام لكل إجابة: امتحان ٥٠ سؤال = ٥١ استعلام في كل حفظ تلقائي، وضرب
// آلاف الطلاب كل كام ثانية بيوصل لعشرات الآلاف من الاستعلامات في الثانية — رقم بيوقّع
// السيرفر من غير ما يظهر أي خطأ في الكود.
//
// الجوين على quiz_questions بيعمل حاجتين في نفس الجملة: بيتأكد إن السؤال من الاختبار ده
// فعلًا (الواجهة مش مصدر ثقة)، وبيحط القيمة في العمود الصح حسب نوع السؤال
async function persistAnswers(attempt, answers) {
  if (!Array.isArray(answers) || !answers.length) return;

  // سؤال متكرر في نفس الطلب بيرمي "cannot affect row a second time" في ON CONFLICT،
  // فآخر قيمة للسؤال هي اللي بتتحفظ
  const byQuestion = new Map();
  for (const answer of answers) {
    const questionId = Number(answer?.question_id);
    if (!Number.isInteger(questionId)) continue;
    const selected = answer?.selected_option === null || answer?.selected_option === undefined
      ? null : Number(answer.selected_option);
    byQuestion.set(questionId, {
      selected: Number.isFinite(selected) ? selected : null,
      essay: answer?.essay_text === null || answer?.essay_text === undefined
        ? null : String(answer.essay_text).slice(0, 20000),
    });
  }
  if (!byQuestion.size) return;

  const ids = [...byQuestion.keys()];
  await pool.query(
    `INSERT INTO quiz_answers (attempt_id, question_id, selected_option, essay_text)
     SELECT $1, t.question_id,
            CASE WHEN q.kind = 'mcq' THEN t.selected_option END,
            CASE WHEN q.kind = 'essay' THEN t.essay_text END
     FROM UNNEST($2::int[], $3::int[], $4::text[]) AS t(question_id, selected_option, essay_text)
     JOIN quiz_questions q ON q.id = t.question_id AND q.quiz_id = $5
     ON CONFLICT (attempt_id, question_id) DO UPDATE
     SET selected_option = EXCLUDED.selected_option, essay_text = EXCLUDED.essay_text`,
    [attempt.id, ids,
      ids.map((id) => byQuestion.get(id).selected),
      ids.map((id) => byQuestion.get(id).essay),
      attempt.quiz_id]);
}

// **التسليم بيقفل المحاولة ويدخلها الطابور — مابيصححش في مكانه.**
//
// امتحان ٢٥ سؤال مقالي معناه ٢٥ نداء للنموذج في اللحظة اللي الطالب بيدوس فيها "سلّم".
// طالب واحد؟ عادي. خمس آلاف طالب في نفس النص ساعة؟ ده آلاف النداءات المتزامنة، يعني
// 429 من المزوّد وطلبات بتموت على timeout والطالب مايعرفش إجاباته اتسجّلت ولا لأ.
//
// دلوقتي التسليم بيكتب الإجابات ويقفل المحاولة فورًا (وده اللي بيهم الطالب فعلًا)،
// والتصحيح بيمشي في الخلفية بمعدل نقدر نتحكم فيه. الصفحة بتسأل عن الدرجة كل كام ثانية.
async function submitAttempt(req, res) {
  const attempt = await loadOpenAttempt(req.params.ref, req.body?.attempt_key);
  if (!attempt) return res.status(404).json({ error: 'المحاولة مش موجودة' });
  if (attempt.submitted_at) return res.status(409).json({ error: 'الاختبار اتسلّم خلاص' });

  await persistAnswers(attempt, req.body?.answers);
  // دقيقة سماح: التسليم التلقائي بيتنفّذ في المتصفح فبيوصل السيرفر متأخر ثواني، والشبكة
  // البطيئة مش ذنب الطالب. أبعد من كده بيتسجّل متأخر ويبان للموظف
  const late = Boolean(attempt.deadline_at && Date.now() > new Date(attempt.deadline_at).getTime() + 60 * 1000);

  await pool.query(
    `UPDATE quiz_attempts SET submitted_at = NOW(), grading_status = 'queued', is_late = is_late OR $1
     WHERE id = $2`, [late, attempt.id]);

  // بيبدأ الطابور فورًا بعد ما الرد يروح — الطالب الوحيد على السيرفر بياخد درجته في ثواني
  // زي الأول، والزحمة هي اللي بتخلي الطابور يطول. الكرون بيلقط الباقي في كل الحالات
  kickGradingQueue();

  res.json({ state: 'grading', score: null, max_score: null, score_hidden: !attempt.show_score_to_student });
}

// نداء واحد شغّال في المرة من المسار ده — الكرون هو اللي بيضمن الاستمرار، وده بس
// بيقصّر الانتظار للطالب اللي سلّم والسيرفر فاضي
let queueKickRunning = false;
function kickGradingQueue() {
  if (queueKickRunning) return;
  queueKickRunning = true;
  processRegradeQueue(4)
    .catch((error) => console.error('❌ Failed to kick the grading queue:', error.message))
    .finally(() => { queueKickRunning = false; });
}

// الصفحة بتسأل بيها كل كام ثانية بعد التسليم. استعلام واحد خفيف — ده اللي هيتنده
// آلاف المرات وقت الزحمة
async function getResult(req, res) {
  const { rows } = await pool.query(
    `SELECT a.id, a.quiz_id, a.submitted_at, a.grading_status, a.score, a.max_score,
            q.show_score_to_student, q.show_answers_to_student
     FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
     WHERE (LOWER(q.slug) = LOWER($1) OR q.token = $1) AND a.attempt_key = $2`,
    [req.params.ref, req.query?.attempt_key || '']);
  const attempt = rows[0];
  if (!attempt) return res.status(404).json({ error: 'المحاولة مش موجودة' });

  // partial = التصحيح خلص بس فيه سؤال محتاج مراجعة موظف. الطالب بياخد اللي اتحسب،
  // مش شاشة انتظار للأبد
  const done = attempt.grading_status === 'graded' || attempt.grading_status === 'partial';
  // **الاستعلام التاني بيتنفّذ مرة واحدة لكل محاولة**: الصفحة بتبطّل تسأل أول ما done
  // تبقى true، فالنداء المتكرر وقت الزحمة بيفضل الاستعلام الخفيف اللي فوق لوحده
  const review = done
    ? await reviewIfReady(attempt, {
      id: attempt.quiz_id,
      show_answers_to_student: attempt.show_answers_to_student,
    })
    : null;
  res.json({
    state: done ? 'submitted' : 'grading',
    score: done && attempt.show_score_to_student ? Number(attempt.score) : null,
    max_score: done && attempt.show_score_to_student ? Number(attempt.max_score) : null,
    score_hidden: !attempt.show_score_to_student,
    review,
  });
}

module.exports = { renderQuiz, startAttempt, saveProgress, submitAttempt, getResult, normalizePhone };
