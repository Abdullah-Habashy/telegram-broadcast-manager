// تصدير نتايج اختبار لملف Excel
//
// **الشيت ده بيروح لكشف الدرجات**، فالمطلوب فيه صف لكل طالب وعمود لكل سؤال — مش نسخة
// من شاشة النتايج. المدرّس بيفتحه ويرتّب ويجمع بنفسه، فأي عمود فيه نص مركّب (زي "٣ من ٥")
// بيبوّظ الترتيب والجمع. الأرقام أرقام والتواريخ تواريخ.
const ExcelJS = require('exceljs');

// نفس تنسيق reportExport: شيت من اليمين، الترويسة عريضة، والخلايا محاذاة يمين
const RTL_VIEW = { views: [{ rightToLeft: true }] };

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

// attempts: صفوف quiz_attempts + اسم المنصة · questions: أسئلة الاختبار مرتّبة (الرؤوس
// معاها) · answers: كل صفوف quiz_answers للاختبار ده
function buildQuizWorkbook({ quiz, questions, attempts, answers }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('النتايج', RTL_VIEW);
  const labels = questionLabels(questions);

  // الرأس مالوش درجة ولا إجابة — عموده كان هيفضل فاضي في كل الصفوف
  const scored = questions.filter((question) => question.kind !== 'group');

  sheet.columns = [
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
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.views = [{ rightToLeft: true, state: 'frozen', xSplit: 1, ySplit: 1 }];

  // درجات كل محاولة في خريطة واحدة — البديل بحث خطي جوه لوب الطلاب، يعني
  // (عدد الطلاب × عدد الأسئلة) عملية بحث على شيت ٥٠٠٠ صف
  const byAttempt = new Map();
  for (const answer of answers) {
    if (!byAttempt.has(answer.attempt_id)) byAttempt.set(answer.attempt_id, new Map());
    byAttempt.get(answer.attempt_id).set(answer.question_id, answer);
  }

  for (const attempt of attempts) {
    const marks = byAttempt.get(attempt.id) || new Map();
    const row = {
      name: attempt.platform_name || attempt.student_name || '',
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
    sheet.addRow(row);
  }

  sheet.getColumn('percent').numFmt = '0%';
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
  });

  // شيت تاني بالإجابات النصية: الشيت الأول للدرجات، وده للمراجعة. فصلهم عن بعض عشان
  // إجابة مقالية من عشر سطور مابتخربش عرض جدول الدرجات
  const detail = workbook.addWorksheet('الإجابات', RTL_VIEW);
  detail.columns = [
    { header: 'الاسم', key: 'name', width: 26 },
    { header: 'السؤال', key: 'label', width: 10 },
    { header: 'نص السؤال', key: 'question', width: 40 },
    { header: 'إجابة الطالب', key: 'answer', width: 50 },
    { header: 'الدرجة', key: 'points', width: 9 },
    { header: 'من', key: 'max', width: 7 },
    { header: 'كلام المصحّح', key: 'reason', width: 44 },
  ];
  detail.getRow(1).font = { bold: true };

  const optionText = (question, index) => {
    if (index === null || index === undefined) return '';
    const option = (question.options || [])[index];
    if (!option) return String(index);
    return typeof option === 'string' ? option : String(option.text || `اختيار ${index + 1}`);
  };

  for (const attempt of attempts) {
    if (!attempt.submitted_at) continue;
    const marks = byAttempt.get(attempt.id) || new Map();
    for (const question of scored) {
      const answer = marks.get(question.id);
      if (!answer) continue;
      detail.addRow({
        name: attempt.platform_name || attempt.student_name || '',
        label: labels.get(question.id),
        question: question.text || '',
        answer: question.kind === 'mcq'
          ? optionText(question, answer.selected_option) : (answer.essay_text || ''),
        points: answer.awarded_points === null ? null : Number(answer.awarded_points),
        max: Number(question.points),
        reason: answer.ai_reason || '',
      });
    }
  }
  detail.eachRow((row) => row.eachCell((cell) => {
    cell.alignment = { horizontal: 'right', vertical: 'top', wrapText: true };
  }));

  return workbook;
}

async function buildQuizBuffer(payload) {
  const workbook = buildQuizWorkbook(payload);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { buildQuizBuffer, questionLabels };
