// ---------- استيراد إجابات Google Forms كمحاولات كاملة ----------
//
//   node tools/local-grader/import-form.js --quiz 14 --file "<الملف>.xlsx"            # تجربة
//   node tools/local-grader/import-form.js --quiz 14 --file "<الملف>.xlsx" --apply    # تنفيذ
//
// الاختبار اتحل على فورم والإجابات في شيت، والنظام مايعرفش عن الطلبة دول حاجة. السكربت
// ده **بيعمللهم محاولات حقيقية** عشان الرابط يشتغل معاهم زي أي طالب: يدخل برقمه، يلاقي
// ورقته، يشوف درجته ونموذج الإجابة، ويتظلم لو حب.
//
// **الاختياري بيتصحّح هنا، والمقالي لأ** — بيتساب `awarded_points = NULL` عن قصد، عشان
// `pull.js` يلقطه بشرطه الطبيعي وتعدّي على `grade.js` و`push.js` زي أي ورقة تانية.
// لو صحّحناه هنا كنا هنكرّر مسار التصحيح في مكان تالت.
//
// **الربط بالرقم، والرقم بيتطبّع بنفس دالة صفحة الطالب بالحرف** (آخر ١٠ أرقام). لو
// اتطبّع بطريقة تانية، الطالب هيدخل برقمه ومايلاقيش ورقته — ويفتح محاولة جديدة فاضية.

const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { psqlJson } = require('./config');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] || true);
}
const apply = process.argv.includes('--apply');

const quizId = Number(arg('quiz'));
const file = String(arg('file') || '');
if (!Number.isInteger(quizId) || quizId <= 0 || !file) {
  console.error('لازم --quiz <رقم> و --file <مسار الشيت>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`الملف مش موجود: ${file}`);
  process.exit(1);
}

// نسخة طبق الأصل من normalizePhone في quizPublic.controller.js — **متغيّرهاش هنا لوحدها**
function normalizePhone(raw) {
  const ascii = String(raw || '').replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
  const digits = ascii.replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// «ا» مع «أ» لأن الطالب بيكتب من كيبورد من غير همزة
const LETTERS = { 'أ': 0, 'ا': 0, 'إ': 0, 'آ': 0, 'ب': 1, 'ج': 2, 'د': 3 };
const escape = (value) => String(value).replace(/'/g, "''");

(async () => {
  // ---------- الأسئلة: الربط بالموضع ----------
  //
  // أسئلة الاختبار ده صور من غير نص، فمفيش نص يتطابق مع عناوين أعمدة الشيت. الربط
  // بالترتيب: عمود «1» = أول سؤال في الاختبار. **بيتأكد إن العدد مطابق** قبل أي حاجة —
  // شيت فيه ٤٠ عمود على اختبار فيه ٤٥ سؤال معناه إجابات بتتحسب على أسئلة غلط.
  const questions = psqlJson(`
    SELECT COALESCE(json_agg(t ORDER BY t.position, t.id), '[]'::json)::text FROM (
      SELECT id, position, kind, correct_option, points::float8 AS points
      FROM quiz_questions WHERE quiz_id = ${quizId}
    ) t;`) || [];
  if (!questions.length) {
    console.error(`الاختبار ${quizId} مالوش أسئلة`);
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const questionColumns = ws.columnCount - 2; // عمودين أول: الاسم والرقم
  if (questionColumns !== questions.length) {
    console.error(`❌ الشيت فيه ${questionColumns} عمود سؤال والاختبار فيه ${questions.length} سؤال.`);
    console.error('   الربط بالترتيب، فالفرق ده معناه إجابات هتتحسب على أسئلة غلط. اتوقف.');
    process.exit(1);
  }

  // ---------- قراءة الصفوف ----------
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const name = (row.getCell(1).text || '').trim();
    const rawPhone = (row.getCell(2).text || '').trim();
    if (!name && !rawPhone) continue;
    const answers = [];
    for (let q = 0; q < questions.length; q += 1) answers.push((row.getCell(3 + q).text || '').trim());
    rows.push({ r, name, rawPhone, phone: normalizePhone(rawPhone), answers });
  }

  const skipped = { phone: [], hasScore: [], duplicate: [], imported: [] };

  // ---------- الأرقام الغلط ----------
  const noPhone = rows.filter((row) => !row.phone);
  skipped.phone = noPhone;
  let usable = rows.filter((row) => row.phone);

  // ---------- المكرر: آخر صف يكسب ----------
  //
  // Google Forms بيضيف الصف الجديد تحت، فآخر صف هو آخر نسخة الطالب رضي عنها — نفس
  // منطق المنصة، الطالب بيكمّل ويسلّم والأخير هو اللي بيتحسب
  const byPhone = new Map();
  for (const row of usable) {
    if (byPhone.has(row.phone)) skipped.duplicate.push(byPhone.get(row.phone));
    byPhone.set(row.phone, row);
  }
  usable = [...byPhone.values()];

  // ---------- مقابل القاعدة ----------
  const list = usable.map((row) => `'${row.phone}'`).join(',');
  // **الفيصل هو «حلّ المقالي؟» مش «عنده درجة؟».** القاعدة الأولى كانت بتحمي أي درجة
  // فوق الصفر، وده اتضح إنه خشن: تلات طلبة فتحوا الاختبار على المنصة، جاوبوا شوية
  // اختيار، وسابوا المقالي كله فاضي — درجتهم ٢ و٦ و٢١ وسقفها ٣٠ أصلًا مش ٤٥، وحلّوا
  // الامتحان كامل على الفورم بعد كده. الورقة الناقصة دي مش امتحان يتحمي.
  // اللي بيتحمي هو اللي حلّ المقالي فعلًا — عنده امتحان حقيقي ممكن الفورم ينزّله.
  const existing = psqlJson(`
    SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (
      SELECT phone, MAX(attempt_no)::int AS last_no,
             MAX(COALESCE(score, 0))::float8 AS best_score,
             MAX(tafra_student_id) AS student_id,
             BOOL_OR(did_essays AND src <> 'google-form') AS keep_theirs,
             BOOL_OR(src = 'google-form') AS already_imported
      FROM (
        SELECT a.phone, a.attempt_no, a.score, a.tafra_student_id, a.source AS src,
               EXISTS (
                 SELECT 1 FROM quiz_answers an JOIN quiz_questions q ON q.id = an.question_id
                 WHERE an.attempt_id = a.id AND q.kind = 'essay'
                   AND (COALESCE(TRIM(an.essay_text), '') <> '' OR an.answer_image_path IS NOT NULL)
               ) AS did_essays
        FROM quiz_attempts a WHERE a.quiz_id = ${quizId} AND a.phone IN (${list})
      ) x GROUP BY phone
    ) t;`) || [];
  const existingByPhone = new Map(existing.map((row) => [row.phone, row]));

  const platform = psqlJson(`
    SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (
      SELECT RIGHT(REGEXP_REPLACE(translate(phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 10) AS p,
             COUNT(*)::int AS n, MIN(tafra_student_id) AS student_id, MIN(name) AS name
      FROM tafra_students
      WHERE RIGHT(REGEXP_REPLACE(translate(phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 10) IN (${list})
      GROUP BY 1
    ) t;`) || [];
  const platformByPhone = new Map(platform.map((row) => [row.p, row]));

  // اتعمل له استيراد قبل كده؟ **إعادة تشغيل الأمر مابتعملش نسخ مكررة** — من غير الشرط
  // ده، تشغيلة تانية بتضيف لكل طالب ورقة جديدة وهو مش عارف
  const already = usable.filter((row) => existingByPhone.get(row.phone)?.already_imported);
  skipped.imported = already;
  const importedPhones = new Set(already.map((row) => row.phone));
  usable = usable.filter((row) => !importedPhones.has(row.phone));

  // الورقة اللي الطالب حلّ فيها المقالي مابتتلمسش — امتحان حقيقي، والفورم ممكن ينزّله
  const complete = usable.filter((row) => existingByPhone.get(row.phone)?.keep_theirs);
  skipped.hasScore = complete;
  const completePhones = new Set(complete.map((row) => row.phone));
  usable = usable.filter((row) => !completePhones.has(row.phone));

  // ---------- بناء المحاولات ----------
  const attempts = usable.map((row) => {
    const match = platformByPhone.get(row.phone);
    // أكتر من طالب على نفس الرقم = إخوات. صفحة الطالب بتخلّيه يختار بنفسه، وإحنا
    // مانقدرش نختار عنه — فبيتسجّل بلا ربط وبالاسم اللي كتبه، والموظف بيشوفه "مش مطابق"
    const studentId = match && match.n === 1 ? Number(match.student_id) : null;
    const studentName = studentId ? match.name : row.name;
    const prior = existingByPhone.get(row.phone);

    let mcqScore = 0;
    const answers = questions.map((question, index) => {
      const raw = row.answers[index];
      if (question.kind === 'mcq') {
        const picked = raw in LETTERS ? LETTERS[raw] : null;
        const correct = picked !== null && picked === question.correct_option;
        if (correct) mcqScore += question.points;
        return {
          question_id: question.id, selected_option: picked,
          awarded: correct ? question.points : 0, is_correct: correct, essay_text: null,
        };
      }
      return {
        question_id: question.id, selected_option: null,
        awarded: null, is_correct: null, essay_text: raw || null,
      };
    });

    return {
      row: row.r,
      phone: row.phone,
      sheet_name: row.name,
      student_id: studentId,
      student_name: studentName,
      attempt_no: (prior?.last_no || 0) + 1,
      attempt_key: crypto.randomBytes(24).toString('hex'),
      mcq_score: mcqScore,
      max_score: questions.reduce((sum, q) => sum + q.points, 0),
      essays: answers.filter((a) => a.essay_text).length,
      answers,
    };
  });

  // ---------- التقرير ----------
  console.log(`\n═══ استيراد فورم → اختبار ${quizId} ═══\n`);
  console.log(`  صفوف في الشيت            ${rows.length}`);
  console.log(`  ⏭️ رقمها مش صالح          ${skipped.phone.length}`);
  console.log(`  ⏭️ صف أقدم لنفس الرقم     ${skipped.duplicate.length}`);
  console.log(`  ⏭️ اتعمل لهم استيراد قبل   ${skipped.imported.length}`);
  console.log(`  ⏭️ حلّوا المقالي على المنصة ${skipped.hasScore.length}`);
  console.log(`  ✅ هيتعمللهم محاولات      ${attempts.length}`);

  if (skipped.phone.length) {
    console.log('\n── اترفضوا: الرقم مش رقم ──');
    for (const row of skipped.phone) console.log(`   صف ${row.r}: ${row.name} — ${JSON.stringify(row.rawPhone)}`);
  }
  if (skipped.duplicate.length) {
    console.log('\n── اترفضوا: صف أقدم لنفس الرقم (الأحدث اتاخد) ──');
    for (const row of skipped.duplicate) console.log(`   صف ${row.r}: ${row.name} · 0${row.phone}`);
  }
  if (skipped.imported.length) {
    console.log('\n── اترفضوا: اتعمل لهم استيراد من الفورم قبل كده ──');
    for (const row of skipped.imported) console.log(`   صف ${row.r}: ${row.name} · 0${row.phone}`);
  }
  if (skipped.hasScore.length) {
    console.log('\n── اترفضوا: حلّوا المقالي على المنصة، فده امتحان حقيقي ──');
    for (const row of skipped.hasScore) {
      console.log(`   صف ${row.r}: ${row.name} · 0${row.phone} · درجته ${existingByPhone.get(row.phone).best_score}`);
    }
  }

  console.log('\n── المحاولات الجديدة ──');
  console.log('   صف  الطالب                    الرقم        اختياري  مقالي  محاولة  مربوط');
  for (const a of attempts) {
    console.log(`   ${String(a.row).padStart(3)} ${String(a.student_name).slice(0, 24).padEnd(26)}`
      + `0${a.phone}  ${String(a.mcq_score).padStart(5)}/30  ${String(a.essays).padStart(4)}`
      + `  ${String(a.attempt_no).padStart(5)}  ${a.student_id ? '✅' : '—'}`);
  }

  const unmatched = attempts.filter((a) => !a.student_id).length;
  console.log(`\n   ${attempts.length - unmatched} مربوطين بحساب المنصة · ${unmatched} مش مطابقين (هيبانوا كده في اللوحة)`);
  console.log(`   ${attempts.reduce((s, a) => s + a.essays, 0)} إجابة مقالية هتستنى التصحيح`);

  if (!apply) {
    console.log('\n↩️ تجربة — مفيش حاجة اتكتبت. للتنفيذ:');
    console.log(`   node tools/local-grader/import-form.js --quiz ${quizId} --file "${file}" --apply`);
    return;
  }

  // ---------- الكتابة ----------
  //
  // معاملة واحدة: محاولة اتكتبت من غير إجاباتها = ورقة فاضية في وش الطالب
  const attemptValues = attempts.map((a) => `(${quizId}, ${a.student_id === null ? 'NULL' : a.student_id},`
    + ` '${escape(a.student_name)}', '${a.phone}', '${a.attempt_key}', ${a.attempt_no},`
    + ` ${a.mcq_score}, ${a.max_score})`).join(',\n    ');

  const answerValues = attempts.flatMap((a) => a.answers.map((ans) => `('${a.attempt_key}', ${ans.question_id},`
    + ` ${ans.selected_option === null ? 'NULL' : ans.selected_option},`
    + ` ${ans.essay_text === null ? 'NULL' : `'${escape(ans.essay_text)}'`},`
    + ` ${ans.awarded === null ? 'NULL' : ans.awarded},`
    + ` ${ans.is_correct === null ? 'NULL' : ans.is_correct})`)).join(',\n    ');

  const SQL = `
BEGIN;

CREATE TEMP TABLE new_attempts (
  quiz_id INT, tafra_student_id BIGINT, student_name TEXT, phone TEXT,
  attempt_key TEXT, attempt_no SMALLINT, score NUMERIC, max_score NUMERIC
) ON COMMIT DROP;
INSERT INTO new_attempts VALUES
    ${attemptValues};

CREATE TEMP TABLE new_answers (
  attempt_key TEXT, question_id INT, selected_option INT,
  essay_text TEXT, awarded NUMERIC, is_correct BOOLEAN
) ON COMMIT DROP;
INSERT INTO new_answers VALUES
    ${answerValues};

-- المحاولة مسلّمة من لحظة إنشائها: الطالب خلّص على الفورم خلاص، ومفيش حاجة تُستأنف.
-- grading_status = 'partial' لأن المقالي لسه — push.js بيحوّلها 'graded' لما يخلص
INSERT INTO quiz_attempts
  (quiz_id, tafra_student_id, student_name, phone, attempt_key, attempt_no,
   started_at, submitted_at, score, max_score, grading_status, source)
SELECT quiz_id, tafra_student_id, student_name, phone, attempt_key, attempt_no,
       NOW(), NOW(), score, max_score, 'partial', 'google-form'
FROM new_attempts;

INSERT INTO quiz_answers
  (attempt_id, question_id, selected_option, essay_text, awarded_points, is_correct, graded_by, graded_at)
SELECT a.id, n.question_id, n.selected_option, n.essay_text, n.awarded, n.is_correct,
       'auto', CASE WHEN n.awarded IS NULL THEN NULL ELSE NOW() END
FROM new_answers n JOIN quiz_attempts a ON a.attempt_key = n.attempt_key;

SELECT json_build_object(
  'awrak', (SELECT COUNT(*) FROM quiz_attempts WHERE source = 'google-form'),
  'egabat', (SELECT COUNT(*) FROM quiz_answers an JOIN quiz_attempts a ON a.id = an.attempt_id
             WHERE a.source = 'google-form'),
  'maqaly_mostanny', (SELECT COUNT(*) FROM quiz_answers an JOIN quiz_attempts a ON a.id = an.attempt_id
             WHERE a.source = 'google-form' AND an.awarded_points IS NULL)
)::text;

COMMIT;
`;

  const summary = psqlJson(SQL);
  if (!summary) {
    console.error('\n❌ السيرفر ماردّش بملخص — الأغلب إن الاستعلام فشل. مفيش حاجة اتكتبت.');
    process.exit(1);
  }
  console.log(`\n✅ اتكتب: ${summary.awrak} ورقة · ${summary.egabat} إجابة`
    + ` · ${summary.maqaly_mostanny} مقالي مستني التصحيح`);
  console.log('\nالخطوة اللي بعدها — التصحيح المحلي بياخدهم لوحده:');
  console.log(`   node tools/local-grader/pull.js  --quiz ${quizId}`);
  console.log(`   node tools/local-grader/grade.js --quiz ${quizId}`);
  console.log(`   node tools/local-grader/push.js  --quiz ${quizId} --apply`);
})().catch((error) => { console.error('FAILED:', error.message); process.exit(1); });
