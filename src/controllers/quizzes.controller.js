const crypto = require('crypto');
const pool = require('../config/db');
const { finalizeAttempt, recalculateAttempt, queueQuizRegrade, processRegradeQueue } = require('../utils/quizScoring');
const { gradeEssayAnswer } = require('../utils/quizGrading');
const { listProviders, PROVIDERS } = require('../utils/aiProviders');
const { streamQuizWorkbook } = require('../utils/quizExport');
const { queueLength } = require('../utils/quizScoring');
const { parseQuizDocument } = require('../utils/quizDocImport');

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
            q.show_score_to_student, q.show_answers_to_student, q.answers_after_close,
            q.shuffle_questions, q.shuffle_options, q.target_bootcamp_id, q.created_at,
            (SELECT COUNT(*)::int FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS question_count,
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.submitted_at IS NOT NULL) AS submitted_count,
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.submitted_at IS NULL) AS in_progress_count,
            -- محتاج تدخّل: تصحيح آلي فشل أو سؤال مقالي لسه من غير درجة
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.grading_status = 'partial') AS needs_review_count,
            (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id = q.id AND a.grading_status = 'regrading') AS regrading_count
     FROM quizzes q ORDER BY q.created_at DESC`);
  res.json(rows.map((row) => ({ ...row, url: quizUrl(req, row) })));
}

async function getQuiz(req, res) {
  const quizId = Number(req.params.id);
  const quizResult = await pool.query('SELECT * FROM quizzes WHERE id = $1', [quizId]);
  const quiz = quizResult.rows[0];
  if (!quiz) return res.status(404).json({ error: 'الاختبار مش موجود' });

  const questions = await pool.query(QUESTIONS_SQL, [quizId]);
  const attemptCount = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quiz_attempts WHERE quiz_id = $1', [quizId]);

  res.json({
    ...quiz,
    url: quizUrl(req, quiz),
    // الواجهة بتقفل زرار حذف السؤال لما يبقى فيه محاولات — الحذف بيمسح إجابات طلاب معاه
    attempt_count: attemptCount.rows[0].count,
    questions: buildQuestionTree(questions.rows),
  });
}

// المعسكر اختياري: القايمة بتبعت "" لما الموظف مايختارش، والفراغ ده لازم يبقى NULL
// مش صفر — صفر معرّف معسكر مش موجود وبيرجّع قايمة متخلّفين فاضية من غير أي رسالة
function normalizeBootcampId(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const SLUG_HELP = 'الرابط المختصر يبقى إنجليزي وأرقام وشرطة بس، من حرفين لأربعين — زي bio-1 أو olom5';

// ---------- صور الأسئلة ----------
// بترجع المسار العام بس. الصورة بتتخزّن على القرص زي صور الإرسال الجماعي — مفيش Object
// Storage في المشروع، وده مقيّد معروف مش قرار جديد
async function uploadQuestionImage(req, res) {
  if (!req.file) return res.status(400).json({ error: 'مفيش صورة مرفوعة' });
  res.json({ path: `/uploads/${req.file.filename}` });
}

// الاختيار بقى كائن {text, image} بدل نص. بنقبل الشكلين وقت القراءة عشان أي صف قديم
// أو أي طلب من واجهة مش متحدّثة يفضل شغّال
function normalizeOptions(raw) {
  return (Array.isArray(raw) ? raw : []).map((option) => (
    typeof option === 'string'
      ? { text: option.trim(), image: null }
      : { text: String(option?.text || '').trim(), image: option?.image || null }));
}

// الاختيار موجود لو فيه نص أو صورة — مش لازم الاتنين
function optionIsFilled(option) {
  return Boolean(option.text || option.image);
}

// نفس القاعدة للسؤال: نص أو صورة يكفي. سؤال صورة بس حالة حقيقية (رسم بياني، معادلة).
// الواجهة بتبعت الحقل باسم image والصف في القاعدة اسمه image_path — الاتنين مقبولين هنا
// عشان نفس الدالة تشتغل على المدخل الجاي من المتصفح وعلى الصف المقروء من القاعدة
function questionIsFilled(question) {
  return Boolean(String(question?.text || '').trim() || question?.image || question?.image_path);
}

// الترتيب: الأب بمكانه، وبعده أبناؤه على طول. COALESCE بتخلي السؤال العادي (اللي مالوش
// أب) يترتب بمكانه هو، والشرط التاني بيحط الأب قبل أبنائه
const QUESTIONS_SQL = `
  SELECT q.id, q.parent_id, q.label, q.position, q.kind, q.text, q.points, q.options,
         q.correct_option, q.reference_answer, q.grading_notes, q.image_path
  FROM quiz_questions q
  LEFT JOIN quiz_questions p ON p.id = q.parent_id
  WHERE q.quiz_id = $1
  ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`;

// بتحوّل الصفوف المسطّحة لشجرة: كل أب ومعاه parts. السؤال العادي بيفضل من غير parts
function buildQuestionTree(rows) {
  const parents = [];
  const byId = new Map();
  for (const row of rows) {
    const question = {
      ...row,
      points: Number(row.points),
      options: normalizeOptions(row.options),
      image: row.image_path || null,
    };
    delete question.image_path;
    if (row.parent_id) {
      const parent = byId.get(row.parent_id);
      if (parent) parent.parts.push(question);
      continue;
    }
    question.parts = [];
    byId.set(row.id, question);
    parents.push(question);
  }
  // الأب اللي فروعه اتمسحت كلها بيرجع سؤال عادي — مش هيكل فاضي في الواجهة
  return parents;
}

async function createQuiz(req, res) {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'عنوان الاختبار مطلوب' });
  const timeLimit = req.body?.time_limit_minutes ? Number(req.body.time_limit_minutes) : null;
  const token = crypto.randomBytes(32).toString('hex');

  const requested = normalizeSlug(req.body?.slug);
  if (requested === false) return res.status(400).json({ error: SLUG_HELP });

  const params = (slug) => [title, String(req.body?.description || '').trim() || null, token, slug,
    Number.isFinite(timeLimit) && timeLimit > 0 ? timeLimit : null,
    req.body?.show_score_to_student !== false, req.body?.show_answers_to_student !== false,
    normalizeBootcampId(req.body?.target_bootcamp_id),
    req.body?.answers_after_close === true,
    req.body?.shuffle_questions === true, req.body?.shuffle_options === true,
    req.session.userId];
  const insert = `INSERT INTO quizzes (title, description, token, slug, time_limit_minutes, show_score_to_student, show_answers_to_student, target_bootcamp_id, answers_after_close, shuffle_questions, shuffle_options, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`;

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
              is_open = $4, show_score_to_student = $5, show_answers_to_student = $6,
              target_bootcamp_id = $7, answers_after_close = $8,
              shuffle_questions = $9, shuffle_options = $10,
              slug = COALESCE($11, slug), updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [title, String(req.body?.description || '').trim() || null,
        Number.isFinite(timeLimit) && timeLimit > 0 ? timeLimit : null,
        req.body?.is_open !== false, req.body?.show_score_to_student !== false,
        req.body?.show_answers_to_student !== false,
        normalizeBootcampId(req.body?.target_bootcamp_id),
        req.body?.answers_after_close === true,
        req.body?.shuffle_questions === true, req.body?.shuffle_options === true,
        requested, quizId]));
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
// من غير id بيتضاف، واللي اختفى من القايمة بيتمسح — **إلا لو فيه محاولات**.
//
// الشكل شجرة: السؤال ممكن يكون عادي، أو أب (kind='group') وتحته parts. الأب بيتكتب
// الأول عشان الأبناء ياخدوا الـ id بتاعه

// **الحروف مكتوبة صراحةً مش محسوبة من يونيكود.** الحساب بإزاحة رقمية بيطلّع "أ ؤ إ ئ" —
// الأبجدية العربية مش متسلسلة في يونيكود زي اللاتينية
const PART_LABELS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي'];

function defaultPartLabel(index) {
  return PART_LABELS[index] || String(index + 1);
}

// بترجع رسالة الخطأ الأولى، أو null لو كله سليم. الرقم في الرسالة زي ما الموظف شايفه
// في المحرر (١، ٢، ٣...) والفرع بحرفه — عشان يلاقيه على طول
function validateQuestion(question, label) {
  if (!questionIsFilled(question)) return `${label} من غير نص ولا صورة`;

  if (question.kind === 'group') {
    const parts = Array.isArray(question.parts) ? question.parts : [];
    if (!parts.length) return `${label} فيه رأس من غير أي فرع — ضيف فرع أو خلّيه سؤال عادي`;
    for (const [index, part] of parts.entries()) {
      const partLabel = `${label} — الفرع ${part.label || defaultPartLabel(index)}`;
      if (part.kind === 'group') return `${partLabel} مينفعش يكون رأس جوه رأس`;
      const error = validateQuestion(part, partLabel);
      if (error) return error;
    }
    return null;
  }

  if (question.kind === 'mcq') {
    const options = normalizeOptions(question.options).filter(optionIsFilled);
    if (options.length < 2) return `${label} محتاج اختيارين على الأقل`;
    if (!Number.isInteger(Number(question.correct_option)) || Number(question.correct_option) >= options.length) {
      return `حدّد الإجابة الصح لـ${label}`;
    }
    return null;
  }

  if (question.kind === 'essay') {
    // **الإجابة المرجعية شرط.** من غيرها التصحيح الآلي مالوش معيار يقارن بيه، والسؤال
    // كان هيتحسب غلط لكل الطلاب من غير أي إشارة إن العيب في السؤال مش في الإجابات
    if (!String(question.reference_answer || '').trim()) {
      return `${label} مقالي ومحتاج إجابة مرجعية — التصحيح الآلي بيقارن بيها`;
    }
    return null;
  }

  return `نوع ${label} غير معروف`;
}

// بتفرد الشجرة لصفوف زي ما هتتخزّن. الأب نقطة تنظيم مش سؤال يتجاوب: درجته صفر دايمًا
// عشان مجموع الدرجات يفضل صح، والدرجة الحقيقية على الفروع
function flattenQuestions(tree) {
  const rows = [];
  tree.forEach((question, position) => {
    rows.push({
      id: Number(question.id) || null,
      parentIndex: null,
      selfIndex: rows.length,
      position,
      label: null,
      kind: question.kind,
      text: String(question.text || '').trim(),
      points: question.kind === 'group' ? 0 : (Number(question.points) > 0 ? Number(question.points) : 1),
      options: question.kind === 'mcq' ? normalizeOptions(question.options).filter(optionIsFilled) : [],
      correct_option: question.kind === 'mcq' ? Number(question.correct_option) : null,
      reference_answer: question.kind === 'essay' ? String(question.reference_answer || '').trim() : null,
      grading_notes: question.kind === 'essay' ? (String(question.grading_notes || '').trim() || null) : null,
      image_path: question.image || null,
    });
    const parentIndex = rows.length - 1;
    if (question.kind !== 'group') return;
    (question.parts || []).forEach((part, partPosition) => {
      rows.push({
        id: Number(part.id) || null,
        parentIndex,
        selfIndex: rows.length,
        position: partPosition,
        // الحرف الافتراضي أ ب ج د لو الموظف ساب الخانة فاضية
        label: String(part.label || '').trim() || defaultPartLabel(partPosition),
        kind: part.kind,
        text: String(part.text || '').trim(),
        points: Number(part.points) > 0 ? Number(part.points) : 1,
        options: part.kind === 'mcq' ? normalizeOptions(part.options).filter(optionIsFilled) : [],
        correct_option: part.kind === 'mcq' ? Number(part.correct_option) : null,
        reference_answer: part.kind === 'essay' ? String(part.reference_answer || '').trim() : null,
        grading_notes: part.kind === 'essay' ? (String(part.grading_notes || '').trim() || null) : null,
        image_path: part.image || null,
      });
    });
  });
  return rows;
}

async function saveQuestions(req, res) {
  const quizId = Number(req.params.id);
  const incoming = Array.isArray(req.body?.questions) ? req.body.questions : null;
  if (!incoming) return res.status(400).json({ error: 'الأسئلة مطلوبة' });

  for (const [index, question] of incoming.entries()) {
    const error = validateQuestion(question, `السؤال رقم ${index + 1}`);
    if (error) return res.status(400).json({ error });
  }

  const rows = flattenQuestions(incoming);
  const existing = await pool.query('SELECT id FROM quiz_questions WHERE quiz_id = $1', [quizId]);
  const existingIds = new Set(existing.rows.map((row) => row.id));
  const keptIds = new Set(rows.map((row) => row.id).filter((id) => existingIds.has(id)));
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

    // الأب لازم يتكتب قبل ابنه عشان الابن ياخد الـ id بتاعه. flattenQuestions بترجّعهم
    // بالترتيب ده أصلًا، وdbIds بتربط رقم الصف في المصفوفة بالـ id الحقيقي بعد الكتابة
    const dbIds = [];
    for (const row of rows) {
      const parentId = row.parentIndex === null ? null : dbIds[row.parentIndex];
      const params = [
        quizId, parentId, row.label, row.position, row.kind, row.text, row.points,
        JSON.stringify(row.options), row.correct_option, row.reference_answer,
        row.grading_notes, row.image_path,
      ];
      if (keptIds.has(row.id)) {
        await client.query(
          `UPDATE quiz_questions SET quiz_id = $1, parent_id = $2, label = $3, position = $4,
                  kind = $5, text = $6, points = $7, options = $8::jsonb, correct_option = $9,
                  reference_answer = $10, grading_notes = $11, image_path = $12
           WHERE id = $13`, [...params, row.id]);
        dbIds.push(row.id);
      } else {
        const inserted = await client.query(
          `INSERT INTO quiz_questions (quiz_id, parent_id, label, position, kind, text, points,
                                       options, correct_option, reference_answer, grading_notes, image_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12) RETURNING id`, params);
        dbIds.push(inserted.rows[0].id);
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

// ---------- نموذج التصحيح ----------
// منفصل عن نموذج الرد الآلي في تبويب الذكاء الصناعي: ده بيحط درجة في ورقة، وده بيتكلم
// مع طالب. المزوّد اللي مفتاحه مش مضبوط على السيرفر بيرجع available: false والواجهة
// بتقفله بدل ما الموظف يختاره ويكتشف الفشل وقت تصحيح أول امتحان
// وضع التصحيح: أي قيمة مش 'queued' معناها فوري — الافتراضي بيكسب لو الصف اتمسح أو
// اتكتب فيه حاجة غريبة، لأن الفوري هو السلوك اللي الطلاب متعوّدين عليه
function normalizeGradingMode(value) {
  return value === 'queued' ? 'queued' : 'instant';
}

async function getGradingProviders(req, res) {
  const [settingsResult, queued] = await Promise.all([
    pool.query("SELECT key, value FROM settings WHERE key IN ('quiz_grading_provider', 'ai_provider', 'quiz_grading_mode')"),
    // طول الطابور بيتعرض جنب الاختيار: الأدمن اللي بيقرر الوضع محتاج يشوف أثره
    queueLength().catch(() => null),
  ]);
  const settings = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));
  const chosen = settings.quiz_grading_provider;
  const current = chosen && PROVIDERS[chosen] ? chosen
    : (settings.ai_provider && PROVIDERS[settings.ai_provider] ? settings.ai_provider : 'anthropic');
  res.json({
    providers: listProviders(),
    current,
    mode: normalizeGradingMode(settings.quiz_grading_mode),
    queue_length: queued,
  });
}

async function setGradingProvider(req, res) {
  const provider = String(req.body?.provider || '').trim();
  if (!PROVIDERS[provider]) return res.status(400).json({ error: 'المزوّد ده مش معروف' });
  // المفتاح الناقص بيتمسك هنا مش وقت تصحيح ورقة: الرسالة للأدمن دلوقتي أنفع بكتير من
  // محاولة تصحيح بتفشل بعد أسبوع على امتحان حقيقي
  if (!PROVIDERS[provider].available()) {
    return res.status(400).json({ error: `مفتاح ${PROVIDERS[provider].label} مش مضبوط على السيرفر` });
  }
  // الوضع بيتحفظ مع المزوّد لأن الاتنين في نفس الكارت وبيتاخدوا بنفس الضغطة — زرارين
  // منفصلين لإعدادين جنب بعض بيخلّي الأدمن يغيّر واحد ويسيب التاني من غير ما ياخد باله
  const mode = normalizeGradingMode(req.body?.mode);
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('quiz_grading_provider', $1), ('quiz_grading_mode', $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [provider, mode]);
  res.json({ ok: true, provider, mode, label: PROVIDERS[provider].label });
}

// ---------- تجربة التصحيح قبل الإرسال ----------
//
// **ليه دي مهمة:** الإجابة المرجعية بتتكتب مرة وبتتحاسب عليها عشرات الطلاب. الطريقة الوحيدة
// لمعرفة إن المرجع مكتوب صح هي إنك تجرّب عليه إجابات فعلية قبل ما تبعت الرابط — إجابة كاملة،
// وناقصة، وغلط — وتشوف الدرجة طلعت منطقية ولا لأ. من غير الخانة دي، أول تجربة حقيقية للمرجع
// بتكون على ورق طلاب حقيقيين.
//
// **مافيش أي كتابة في قاعدة البيانات هنا** — لا محاولة ولا إجابة ولا سجل. نداء واحد للنموذج
// ورد، فالموظف يقدر يجرّب عشرين إجابة من غير ما يوسّخ نتايج أي اختبار
async function gradePreview(req, res) {
  const question = String(req.body?.text || '').trim();
  const reference = String(req.body?.reference_answer || '').trim();
  const studentAnswer = String(req.body?.student_answer || '').trim();
  if (!question) return res.status(400).json({ error: 'اكتب السؤال' });
  if (!reference) return res.status(400).json({ error: 'اكتب الإجابة المرجعية — من غيرها مفيش معيار للتصحيح' });
  if (!studentAnswer) return res.status(400).json({ error: 'اكتب إجابة الطالب التجريبية' });

  const points = Number(req.body?.points) > 0 ? Number(req.body.points) : 1;
  const startedAt = Date.now();
  try {
    // provider اختياري: بيخلي الموظف يجرّب نفس الإجابة على أكتر من نموذج ويقارن قبل
    // ما يعتمد واحد فيهم. من غيره بيستخدم المحفوظ
    const requested = String(req.body?.provider || '').trim();
    if (requested && !PROVIDERS[requested]) return res.status(400).json({ error: 'المزوّد ده مش معروف' });
    const grade = await gradeEssayAnswer({
      question,
      referenceAnswer: reference,
      gradingNotes: String(req.body?.grading_notes || '').trim(),
      studentAnswer,
      provider: requested || undefined,
    });
    res.json({
      ...grade,
      points,
      // نفس التقريب اللي بيتحسب بيه الطالب فعلًا (توثيق: finalizeAttempt)
      awarded_points: Number((points * grade.score_ratio).toFixed(2)),
      latency_ms: Date.now() - startedAt,
    });
  } catch (error) {
    // الرسالة بتوصل الموظف زي ما هي: "المفتاح مش مضبوط" حاجة يقدر يتصرف فيها،
    // و"حصل خطأ" مايقدرش
    res.status(502).json({ error: `التصحيح فشل: ${error.message}` });
  }
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
    // الأب بيرجع في النتيجة زي أي سؤال — الموظف محتاج يقرا رأس السؤال قبل الفروع عشان
    // يحكم على إجابتها. مالوش صف في quiz_answers فحقوله بتبقى NULL وده متوقع
    `SELECT q.id AS question_id, q.parent_id, q.label, q.position, q.kind, q.text, q.points,
            q.options, q.correct_option, q.reference_answer, q.image_path,
            an.id AS answer_id, an.selected_option, an.essay_text, an.awarded_points,
            an.is_correct, an.ai_verdict, an.ai_reason, an.ai_provider, an.graded_by,
            u.name AS graded_by_name
     FROM quiz_questions q
     LEFT JOIN quiz_questions p ON p.id = q.parent_id
     LEFT JOIN quiz_answers an ON an.question_id = q.id AND an.attempt_id = $1
     LEFT JOIN users u ON u.id = an.graded_by_user
     WHERE q.quiz_id = $2
     ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`,
    [attemptId, attempt.quiz_id]);

  res.json({
    attempt: {
      ...attempt,
      score: attempt.score === null ? null : Number(attempt.score),
      max_score: attempt.max_score === null ? null : Number(attempt.max_score),
    },
    answers: rows.map((row) => ({
      ...row,
      points: Number(row.points),
      options: normalizeOptions(row.options),
      image: row.image_path || null,
      is_part: row.parent_id !== null,
      awarded_points: row.awarded_points === null ? null : Number(row.awarded_points),
    })),
  });
}

// ---------- استيراد أسئلة من ملف Word ----------
//
// **بيقرا ومابيكتبش.** الناتج بيرجع للمحرر عشان الموظف يشوفه ويحفظ بنفسه — ملف فيه
// غلطة في علامة واحدة بيبوّظ اختبار كامل لو دخل القاعدة على طول، والتحذيرات اللي
// بترجع معاه هي اللي بتخلّي الغلطة دي تبان قبل الحفظ.
//
// الملف بيتقرا من الذاكرة مش من القرص: إحنا محتاجين نصه بس، والاحتفاظ بيه بعد القراءة
// معناه مجلد بيكبر بملفات محدش هيفتحها تاني
async function parseDocument(req, res) {
  let text = String(req.body?.text || '');
  if (req.file) {
    // mammoth بيفك الـ docx ويطلّع النص. لو الملف مش docx صالح بيرمي، والرسالة
    // بتوصل للموظف زي ما هي عشان يعرف إن المشكلة في الملف مش في الصيغة
    const mammoth = require('mammoth');
    try {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } catch (error) {
      return res.status(400).json({ error: 'مقدرناش نقرا الملف — لازم يكون .docx (مش .doc القديم ولا PDF)' });
    }
  }
  if (!text.trim()) return res.status(400).json({ error: 'ارفع ملف Word أو الصق النص' });

  const parsed = parseQuizDocument(text);
  if (!parsed.questions.length) {
    return res.status(400).json({
      error: 'مالقيناش أي سؤال. كل سؤال لازم يبدأ بسطر فيه س1) والإجابة ج1) والدرجة د1)',
      warnings: parsed.warnings,
    });
  }
  res.json(parsed);
}

// ---------- مين حلّ ومين ماحلّش ----------
//
// الاختبار ممكن يتربط بمعسكر (target_bootcamp_id). من غير الربط ده إحنا عارفين بس مين
// دخل — ومش عارفين **مين كان المفروض يدخل**، وده الرقم اللي بيتصرّف فيه: قايمة أرقام
// تروح لتيم المكالمات أو لرسالة جماعية.
//
// القايمة بتتقفل عند حد أعلى: معسكر فيه ٣٠٠٠ طالب مالوش لازمة يتحمّل كله في صفحة —
// العدد هو اللي بيتقري، والقايمة للتصرّف
const MISSING_LIMIT = 500;

// **الربط بمعرّف الطالب على المنصة مش بالتليفون.** الطالب اللي رقمه مش على المنصة
// بيتسجّل tafra_student_id = NULL، فمابيتحسبش إنه حلّ حتى لو حلّ فعلًا — وعشان كده
// بنرجّع عدده لوحده بدل ما نسكت عنه ونخلي الأرقام تبان ناقصة من غير سبب
async function getQuizCoverage(req, res) {
  const quizId = Number(req.params.id);
  const quizResult = await pool.query(
    `SELECT q.id, q.target_bootcamp_id, b.name AS bootcamp_name
     FROM quizzes q
     LEFT JOIN tafra_bootcamps b ON b.tafra_bootcamp_id = q.target_bootcamp_id
     WHERE q.id = $1`, [quizId]);
  const quiz = quizResult.rows[0];
  if (!quiz) return res.status(404).json({ error: 'الاختبار مش موجود' });
  if (!quiz.target_bootcamp_id) {
    return res.json({ configured: false });
  }

  const [counts, missing, unmatched] = await Promise.all([
    // EXISTS مش جوين: الطالب ممكن يكون عنده محاولتين برقمين مختلفين (الفهرس الفريد
    // بيسمح بده)، والجوين وقتها بيعدّه مرتين
    pool.query(
      `SELECT COUNT(*)::int AS enrolled,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM quiz_attempts a WHERE a.quiz_id = $2
                  AND a.tafra_student_id = e.tafra_student_id AND a.submitted_at IS NOT NULL))::int AS submitted,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM quiz_attempts a WHERE a.quiz_id = $2
                  AND a.tafra_student_id = e.tafra_student_id AND a.submitted_at IS NULL))::int AS in_progress
       FROM tafra_enrollments e
       WHERE e.tafra_bootcamp_id = $1 AND e.enrollment_type = 'enroll'`,
      [quiz.target_bootcamp_id, quizId]),
    pool.query(
      `SELECT s.tafra_student_id, s.name, s.phone, s.telegram_chat_id
       FROM tafra_enrollments e
       JOIN tafra_students s ON s.tafra_student_id = e.tafra_student_id
       WHERE e.tafra_bootcamp_id = $1 AND e.enrollment_type = 'enroll'
         AND NOT EXISTS (SELECT 1 FROM quiz_attempts a
                         WHERE a.quiz_id = $2 AND a.tafra_student_id = s.tafra_student_id)
       ORDER BY s.name
       LIMIT $3`,
      [quiz.target_bootcamp_id, quizId, MISSING_LIMIT]),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM quiz_attempts
       WHERE quiz_id = $1 AND tafra_student_id IS NULL AND submitted_at IS NOT NULL`, [quizId]),
  ]);

  const totals = counts.rows[0];
  res.json({
    configured: true,
    bootcamp_name: quiz.bootcamp_name,
    ...totals,
    missing_count: totals.enrolled - totals.submitted - totals.in_progress,
    unmatched_submitted: unmatched.rows[0].count,
    limit: MISSING_LIMIT,
    missing: missing.rows.map((row) => ({
      ...row,
      // الطالب اللي مربوط بتيليجرام تقدر توصله برسالة، واللي لأ محتاج مكالمة
      reachable: row.telegram_chat_id !== null,
      telegram_chat_id: undefined,
    })),
  });
}

// قايمة الأبواب لقايمة الاختيار في محرر الاختبار. موجودة هنا مش تحت /api/tafra عشان
// التيم العلمي يقدر يوصلها — صلاحياته على الاختبارات مش على شاشات طفرة
async function listBootcamps(req, res) {
  const { rows } = await pool.query(
    'SELECT tafra_bootcamp_id AS id, name FROM tafra_bootcamps WHERE is_available = TRUE ORDER BY name');
  res.json(rows);
}

// ---------- تصدير النتايج ----------
//
// **الملف بيتكتب على الرد مباشرة، مش بيتبني في الذاكرة الأول.** امتحان بعشرين ألف طالب
// و٢٥ سؤال = نص مليون صف في شيت الإجابات؛ تحميلهم كلهم عشان نبني Buffer بياكل أكتر من
// جيجا على سيرفر ٢ جيجا ويقتل العملية — ومعاها كل الطلاب اللي بيحلّوا في نفس اللحظة.
//
// المحاولات بتتقرا على دفعات، وإجابات كل دفعة بتتجاب معاها. الترتيب `a.id` مش الدرجة:
// الترقيم لازم يبقى ثابت بين الدفعات، والترتيب بعمود ممكن يتغيّر (الدرجة بتتحدّث وقت
// التصحيح) بيخلي صف يتكرر في دفعة ويختفي من التانية
async function exportAttempts(req, res) {
  const quizId = Number(req.params.id);
  const quizResult = await pool.query('SELECT id, title FROM quizzes WHERE id = $1', [quizId]);
  const quiz = quizResult.rows[0];
  if (!quiz) return res.status(404).json({ error: 'الاختبار مش موجود' });

  const questions = await pool.query(
    `SELECT q.id, q.parent_id, q.label, q.kind, q.text, q.points, q.options
     FROM quiz_questions q
     LEFT JOIN quiz_questions p ON p.id = q.parent_id
     WHERE q.quiz_id = $1
     ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`,
    [quizId]);

  const fetchAttempts = async (offset, limit) => {
    const { rows } = await pool.query(
      `SELECT a.id, a.student_name, a.phone, a.tafra_student_id, a.started_at, a.submitted_at,
              a.is_late, a.score, a.max_score, a.grading_status, s.name AS platform_name
       FROM quiz_attempts a
       LEFT JOIN tafra_students s ON s.tafra_student_id = a.tafra_student_id
       WHERE a.quiz_id = $1
       ORDER BY a.id
       LIMIT $2 OFFSET $3`, [quizId, limit, offset]);
    return rows;
  };

  const fetchAnswers = async (attemptIds) => {
    if (!attemptIds.length) return [];
    const { rows } = await pool.query(
      `SELECT an.attempt_id, an.question_id, an.selected_option, an.essay_text,
              an.awarded_points, an.ai_reason
       FROM quiz_answers an
       WHERE an.attempt_id = ANY($1::int[])`, [attemptIds]);
    return rows;
  };

  // اسم الملف بيتنضّف من كل حاجة ممكن تكسر ترويسة HTTP أو اسم ملف على ويندوز — عنوان
  // الاختبار بيكتبه الموظف وممكن يكون فيه أي حاجة
  const safeTitle = String(quiz.title).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'quiz';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle)}.xlsx`);

  try {
    await streamQuizWorkbook({
      stream: res, questions: questions.rows, fetchAttempts, fetchAnswers,
    });
  } catch (error) {
    // الترويسات راحت خلاص، فمفيش رسالة خطأ ممكن تتبعت — الوصلة بتتقطع والمتصفح بيوري
    // "التنزيل فشل"، وهو أصدق من ملف ناقص بيتفتح ويبان سليم
    console.error('❌ Failed to stream the quiz export:', error.message);
    res.destroy(error);
  }
}

// ---------- إحصائيات على مستوى السؤال ----------
//
// **ده مقلوب شاشة المحاولة.** المحاولة بتقول "الطالب ده عمل إيه"، ودي بتقول "السؤال ده
// عمل إيه في الكل" — وهي دي اللي بتفيد في التدريس: السؤال اللي وقّع نص الفصل معناه إن
// المعلومة نفسها محتاجة تتشرح تاني، مش إن الطلاب مذاكروش.
//
// المحاولات اللي لسه بتتحل مابتتحسبش (EXISTS على submitted_at) — نص ورقة بتحرّف النسبة.
// ورؤوس الأسئلة مستبعدة: الأب مالوش إجابة ولا درجة، فروعه هي اللي بتتصحّح
const QUESTION_STATS_SQL = `
  SELECT q.id AS question_id, q.parent_id, q.label, q.kind, q.text, q.points,
         COUNT(an.id)::int AS answered,
         COUNT(*) FILTER (WHERE an.awarded_points >= q.points)::int AS full_marks,
         COUNT(*) FILTER (WHERE an.awarded_points > 0 AND an.awarded_points < q.points)::int AS partial,
         COUNT(*) FILTER (WHERE an.awarded_points = 0)::int AS zero,
         COUNT(*) FILTER (WHERE an.id IS NOT NULL AND an.awarded_points IS NULL)::int AS ungraded,
         AVG(an.awarded_points / NULLIF(q.points, 0)) AS avg_ratio
  FROM quiz_questions q
  LEFT JOIN quiz_questions p ON p.id = q.parent_id
  LEFT JOIN quiz_answers an ON an.question_id = q.id
    AND EXISTS (SELECT 1 FROM quiz_attempts a
                WHERE a.id = an.attempt_id AND a.submitted_at IS NOT NULL)
  WHERE q.quiz_id = $1 AND q.kind <> 'group'
  GROUP BY q.id, p.position
  ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`;

// توزيع الاختيارات: أنهي اختيار غلط شدّ أكتر الطلاب. ده أنفع من نسبة الغلط لوحدها —
// اختيار غلط واحد ماشي عليه ٤٠٪ معناه إن فيه فهم غلط بعينه، مش تخمين عشوائي
const OPTION_STATS_SQL = `
  SELECT an.question_id, an.selected_option, COUNT(*)::int AS picks
  FROM quiz_answers an
  JOIN quiz_attempts a ON a.id = an.attempt_id
  JOIN quiz_questions q ON q.id = an.question_id
  WHERE q.quiz_id = $1 AND q.kind = 'mcq' AND a.submitted_at IS NOT NULL
  GROUP BY an.question_id, an.selected_option`;

async function getQuestionStats(req, res) {
  const quizId = Number(req.params.id);
  const quiz = await pool.query('SELECT id, title FROM quizzes WHERE id = $1', [quizId]);
  if (!quiz.rows.length) return res.status(404).json({ error: 'الاختبار مش موجود' });

  const [questions, options, attempts] = await Promise.all([
    pool.query(QUESTION_STATS_SQL, [quizId]),
    pool.query(OPTION_STATS_SQL, [quizId]),
    pool.query(
      `SELECT COUNT(*)::int AS submitted, AVG(score / NULLIF(max_score, 0)) AS avg_ratio
       FROM quiz_attempts WHERE quiz_id = $1 AND submitted_at IS NOT NULL`, [quizId]),
  ]);

  // الاختيارات بتترجع من استعلام تاني وبتتلمّ هنا حسب السؤال — أرخص من جوين بيكرّر
  // صفوف الأسئلة على كل اختيار
  const picksByQuestion = new Map();
  for (const row of options.rows) {
    if (!picksByQuestion.has(row.question_id)) picksByQuestion.set(row.question_id, []);
    picksByQuestion.get(row.question_id).push({
      option: row.selected_option, picks: row.picks,
    });
  }

  // نص السؤال والاختيارات محتاجين يتعرضوا جنب الأرقام — الموظف مش هيفتكر سؤال ٧ إيه.
  // **والترتيب هنا مقصود**: الرقم اللي بيتحسب منه لازم يطابق الرقم اللي الطالب شافه في
  // ورقته، وده بيعُد الرؤوس كمان — فلو استبعدناها زي استعلام الإحصائيات، سؤال ٥ عند
  // الموظف يبقى سؤال ٦ عند الطالب ومحدش ياخد باله
  const texts = await pool.query(
    `SELECT q.id, q.parent_id, q.kind, q.label, q.options, q.correct_option, q.image_path
     FROM quiz_questions q
     LEFT JOIN quiz_questions p ON p.id = q.parent_id
     WHERE q.quiz_id = $1
     ORDER BY COALESCE(p.position, q.position), (q.parent_id IS NOT NULL), q.position, q.id`, [quizId]);
  const byId = new Map(texts.rows.map((row) => [row.id, row]));

  const numbers = new Map();
  let counter = 0;
  for (const row of texts.rows) {
    if (row.parent_id === null) counter += 1;
    numbers.set(row.id, counter);
  }

  res.json({
    submitted: attempts.rows[0].submitted,
    avg_ratio: attempts.rows[0].avg_ratio === null ? null : Number(attempts.rows[0].avg_ratio),
    questions: questions.rows.map((row) => {
      const source = byId.get(row.question_id) || {};
      return {
        ...row,
        points: Number(row.points),
        is_part: row.parent_id !== null,
        number: numbers.get(row.question_id) || null,
        avg_ratio: row.avg_ratio === null ? null : Number(row.avg_ratio),
        options: normalizeOptions(source.options),
        correct_option: source.correct_option,
        image: source.image_path || null,
        picks: picksByQuestion.get(row.question_id) || [],
      };
    }),
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

// ---------- إعادة فتح المحاولة ----------
//
// **المحاولة واحدة لكل طالب، ومفيش مسار كان بيفكّها.** الطالب اللي سلّم بالغلط، أو دخل
// برقم غلط، أو النت قطع عليه في النص — مقفول نهائيًا ومحدش يقدر يساعده، وده بيتحوّل
// لتذكرة دعم في كل مرة. الزرار ده بيفكّها.
//
// **بيمسح إجابات الطالب فعلًا.** مفيش رجوع، وعشان كده بيتسجّل مين فتحها وامتى وكام مرة —
// مفيش Audit Log في المشروع، والتلات أعمدة دي هي الأثر الوحيد لو حد سأل بعدين.
//
// الوقت بيترجّع NULL مش NOW+المدة: الموظف بيفتحها دلوقتي والطالب ممكن يدخل بكرة، فحساب
// الميعاد من دلوقتي معناه إنه يلاقي الوقت خلص. startAttempt بيحسبه أول ما يدخل فعلًا
async function reopenAttempt(req, res) {
  const attemptId = Number(req.params.attemptId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT a.id, a.quiz_id, q.is_open FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id WHERE a.id = $1 FOR UPDATE`, [attemptId]);
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'المحاولة مش موجودة' });
    }
    const deleted = await client.query(
      'DELETE FROM quiz_answers WHERE attempt_id = $1', [attemptId]);
    await client.query(
      `UPDATE quiz_attempts
       SET submitted_at = NULL, score = NULL, max_score = NULL, grading_status = 'pending',
           grading_error = NULL, is_late = FALSE, deadline_at = NULL, started_at = NOW(),
           result_notified_at = NULL,
           reopened_at = NOW(), reopened_by = $2, reopen_count = reopen_count + 1
       WHERE id = $1`, [attemptId, req.session.userId]);
    await client.query('COMMIT');
    res.json({
      ok: true,
      deleted_answers: deleted.rowCount,
      // الاختبار المقفول رابطه مابيفتحش أصلًا، فالمحاولة المفتوحة مالهاش لازمة لحد ما يتفتح
      quiz_is_open: existing.rows[0].is_open,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// إعادة تصحيح **كل** محاولات الاختبار — بعد ما الموظف يعدّل إجابة مرجعية أو تعليمات تصحيح
// أو الإجابة الصح في سؤال اختياري. بيرد فورًا بعدد اللي دخل الطابور، والتصحيح بيمشي ورا.
async function regradeQuiz(req, res) {
  const quizId = Number(req.params.id);
  const exists = await pool.query('SELECT id FROM quizzes WHERE id = $1', [quizId]);
  if (!exists.rows.length) return res.status(404).json({ error: 'الاختبار مش موجود' });

  const queued = await queueQuizRegrade(quizId);
  if (!queued.attempts) return res.json({ ...queued, started: false });

  // بيشتغل بعد ما الرد يروح — الموظف مايستناش، والكرون كل دقيقتين بيكمّل الباقي وبيلقط
  // الطابور من أوله لو السيرفر اتقفل دلوقتي
  processRegradeQueue(10).catch((error) =>
    console.error('❌ Failed to start the quiz regrade queue:', error.message));

  res.json({ ...queued, started: true });
}

module.exports = {
  listQuizzes, getQuiz, createQuiz, updateQuiz, deleteQuiz, saveQuestions,
  listAttempts, getAttempt, gradeAnswer, regradeAttempt, regradeQuiz, gradePreview,
  getQuestionStats, exportAttempts, getQuizCoverage, listBootcamps, reopenAttempt, parseDocument, parseDocument,
  getGradingProviders, setGradingProvider, uploadQuestionImage,
};
