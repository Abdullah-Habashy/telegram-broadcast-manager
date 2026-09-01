// تصدير نتايج اختبار لملف Excel
//
// **الشيت ده بيروح لكشف الدرجات**، فالمطلوب فيه صف لكل طالب وعمود لكل سؤال — مش نسخة
// من شاشة النتايج. المدرّس بيفتحه ويرتّب ويجمع بنفسه، فأي عمود فيه نص مركّب (زي "٣ من ٥")
// بيبوّظ الترتيب والجمع. الأرقام أرقام والتواريخ تواريخ.
//
// **والملف بيتكتب على دفعات مش مرة واحدة في الذاكرة.**
// النسخة الأولى كانت بتحمّل كل المحاولات وكل الإجابات في مصفوفتين وتبني الملف كله في
// الرام. على ٢١ إجابة ده مالوش أي معنى — على امتحان بعشرين ألف طالب و٢٥ سؤال بيبقى
// **نص مليون صف** في شيت الإجابات، والملف الناتج والمصفوفات مع بعض بياكلوا أكتر من جيجا
// على سيرفر ٢ جيجا. WorkbookWriter بيكتب الصفوف على الـstream أول بأول والذاكرة بتفضل
// محدودة مهما كبر الاختبار.
const ExcelJS = require('exceljs');

// نفس تنسيق reportExport: شيت من اليمين، الترويسة عريضة، والخلايا محاذاة يمين
const RTL_VIEW = { views: [{ rightToLeft: true }] };

// حجم الدفعة: عدد المحاولات اللي بتتقرا من القاعدة مع إجاباتها في المرة الواحدة.
// ٥٠٠ محاولة × ٢٥ سؤال = ١٢٥٠٠ صف إجابة في الذاكرة في أي لحظة — رقم مريح، والقراءات
// أقل من إن كل محاولة تتقرا لوحدها
const CHUNK = 500;

function formatDate(value) {
  return value ? new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

const STATUS_LABELS = {
  pending: 'لسه بيحل',
  queued: 'في طابور التصحيح',
  regrading: 'بيتصحّح من جديد',
  graded: 'اتصحّح',
  partial: 'محتاج مراجعة',
};

// ترقيم زي ما الطالب شافه بالظبط: الرؤوس بتتعد، والفرع بياخد رقم أبوه وحرفه.
// أي ترقيم تاني معناه إن المدرّس يقارن عمود في الشيت بسؤال في الورقة ويلاقيهم مختلفين
function questionLabels(questions) {
  const labels = new Map();
  let number = 0;
  for (const question of questions) {
    if (question.parent_id === null) number += 1;
    labels.set(question.id, question.parent_id === null
      ? `س${number}`
      : `س${number}${question.label ? ` (${question.label})` : ''}`);
  }
  return labels;
}

function optionText(question, index) {
  if (index === null || index === undefined) return '';
  const option = (question.options || [])[index];
  if (!option) return String(index);
  return typeof option === 'string' ? option : String(option.text || `اختيار ${index + 1}`);
}

function gradesColumns(scored, labels) {
  return [
    { header: 'الاسم', key: 'name', width: 28 },
    { header: 'الموبايل', key: 'phone', width: 15 },
    { header: 'على المنصة', key: 'matched', width: 12 },
    { header: 'بدأ', key: 'started', width: 18 },
    { header: 'سلّم', key: 'submitted', width: 18 },
    { header: 'متأخر', key: 'late', width: 8 },
    { header: 'الدرجة', key: 'score', width: 9 },
    { header: 'من', key: 'max_score', width: 8 },
    { header: 'النسبة', key: 'percent', width: 9 },
    { header: 'حالة التصحيح', key: 'status', width: 16 },
    ...scored.map((question) => ({
      header: `${labels.get(question.id)} (${Number(question.points)})`,
      key: `q${question.id}`,
      width: 11,
    })),
  ];
}

const DETAIL_COLUMNS = [
  { header: 'الاسم', key: 'name', width: 26 },
  { header: 'السؤال', key: 'label', width: 10 },
  { header: 'نص السؤال', key: 'question', width: 40 },
  { header: 'إجابة الطالب', key: 'answer', width: 50 },
  { header: 'الدرجة', key: 'points', width: 9 },
  { header: 'من', key: 'max', width: 7 },
  { header: 'كلام المصحّح', key: 'reason', width: 44 },
];

function studentName(attempt) {
  return attempt.platform_name || attempt.student_name || '';
}

function gradesRow(attempt, scored, marks) {
  const row = {
    name: studentName(attempt),
    phone: attempt.phone || '',
    matched: attempt.tafra_student_id ? 'نعم' : 'لأ',
    started: formatDate(attempt.started_at),
    submitted: formatDate(attempt.submitted_at),
    late: attempt.is_late ? 'متأخر' : '',
    score: attempt.score === null ? null : Number(attempt.score),
    max_score: attempt.max_score === null ? null : Number(attempt.max_score),
    percent: attempt.score === null || !Number(attempt.max_score)
      ? null : Math.round((Number(attempt.score) / Number(attempt.max_score)) * 100) / 100,
    status: STATUS_LABELS[attempt.grading_status] || attempt.grading_status,
  };
  for (const question of scored) {
    const answer = marks.get(question.id);
    // الفرق بين "خد صفر" و"السؤال لسه متصححش" لازم يفضل باين في الشيت: الصفر رقم
    // والفاضي فاضي. لو حطّينا صفر في الاتنين، المدرّس بيجمع درجات ورقة نصها متصححش
    row[`q${question.id}`] = answer && answer.awarded_points !== null
      ? Number(answer.awarded_points) : null;
  }
  return row;
}

// الإجابات بتتلمّ في خريطة لكل محاولة — البديل بحث خطي جوه لوب الأسئلة، يعني
// (عدد الطلاب × عدد الأسئلة) عملية بحث
function groupAnswers(answers) {
  const byAttempt = new Map();
  for (const answer of answers) {
    if (!byAttempt.has(answer.attempt_id)) byAttempt.set(answer.attempt_id, new Map());
    byAttempt.get(answer.attempt_id).set(answer.question_id, answer);
  }
  return byAttempt;
}

// **مرّتين على المحاولات مش مرة.** WorkbookWriter بيكتب الشيتات بالترتيب: الشيت لازم
// يتقفل قبل ما اللي بعده يبدأ، فمافيش طريقة نملى الاتنين في مرور واحد. قراءة زيادة من
// القاعدة أرخص بكتير من إن نمسك نص مليون صف في الذاكرة عشان نوفّرها.
async function eachChunk(fetchAttempts, handle) {
  for (let offset = 0; ; offset += CHUNK) {
    const attempts = await fetchAttempts(offset, CHUNK);
    if (!attempts.length) return;
    await handle(attempts);
    if (attempts.length < CHUNK) return;
  }
}

// stream: مجرى الرد · fetchAttempts(offset, limit) · fetchAnswers(attemptIds)
async function streamQuizWorkbook({ stream, questions, fetchAttempts, fetchAnswers }) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const labels = questionLabels(questions);
  // الرأس مالوش درجة ولا إجابة — عموده كان هيفضل فاضي في كل الصفوف
  const scored = questions.filter((question) => question.kind !== 'group');
  const byId = new Map(questions.map((question) => [question.id, question]));

  // ---------- شيت الدرجات ----------
  const grades = workbook.addWorksheet('النتايج', RTL_VIEW);
  grades.columns = gradesColumns(scored, labels);
  grades.getRow(1).font = { bold: true };
  grades.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  grades.getRow(1).commit();

  await eachChunk(fetchAttempts, async (attempts) => {
    const byAttempt = groupAnswers(await fetchAnswers(attempts.map((a) => a.id)));
    for (const attempt of attempts) {
      const row = grades.addRow(gradesRow(attempt, scored, byAttempt.get(attempt.id) || new Map()));
      row.alignment = { horizontal: 'right', vertical: 'middle' };
      row.commit();
    }
  });
  grades.getColumn('percent').numFmt = '0%';
  grades.commit();

  // ---------- شيت الإجابات ----------
  // منفصل عن الدرجات لأن إجابة مقالية من عشر سطور بتخرّب عرض جدول الدرجات
  const detail = workbook.addWorksheet('الإجابات', RTL_VIEW);
  detail.columns = DETAIL_COLUMNS;
  detail.getRow(1).font = { bold: true };
  detail.getRow(1).commit();

  await eachChunk(fetchAttempts, async (attempts) => {
    const submitted = attempts.filter((attempt) => attempt.submitted_at);
    if (!submitted.length) return;
    const byAttempt = groupAnswers(await fetchAnswers(submitted.map((a) => a.id)));
    for (const attempt of submitted) {
      const marks = byAttempt.get(attempt.id) || new Map();
      for (const question of scored) {
        const answer = marks.get(question.id);
        if (!answer) continue;
        const row = detail.addRow({
          name: studentName(attempt),
          label: labels.get(question.id),
          question: byId.get(question.id)?.text || '',
          answer: question.kind === 'mcq'
            ? optionText(question, answer.selected_option) : (answer.essay_text || ''),
          points: answer.awarded_points === null ? null : Number(answer.awarded_points),
          max: Number(question.points),
          reason: answer.ai_reason || '',
        });
        row.alignment = { horizontal: 'right', vertical: 'top', wrapText: true };
        row.commit();
      }
    }
  });
  detail.commit();

  await workbook.commit();
}

module.exports = { streamQuizWorkbook, questionLabels, CHUNK };
