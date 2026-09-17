// ---------- سحب دفعة تصحيح من الإنتاج للجهاز ----------
//
//   node tools/local-grader/pull.js --quiz 14 [--limit 200] [--images-only] [--all]
//                                   [--attempts 10] [--attempt-ids 1,2,3]
//                                   [--q-no 37] [--question-ids 187,188]
//
// بيكتب `manifest.json` + مجلد `images/` في مساحة الشغل. الصور بتتنزّل مرة واحدة —
// إعادة التشغيل بتتخطّى اللي موجود، فلو الشبكة قطعت في النص كمّل من مكانك.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SSH_HOST, sshArgs, psqlJson, REMOTE_APP, quizWorkDir } = require('./config');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] || true);
}
const flag = (name) => process.argv.includes(`--${name}`);

const quizId = Number(arg('quiz'));
if (!Number.isInteger(quizId) || quizId <= 0) {
  console.error('لازم --quiz <رقم الاختبار>');
  process.exit(1);
}
const limit = Number(arg('limit', 0)) || null;
// **بالورقة مش بالسؤال.** `--limit` بياخد إجابات متفرقة من أوراق مختلفة، وده مابينفعش
// لو عايز تقارن درجة ورقة كاملة قديمة بجديدة — لازم كل أسئلة الورقة تتصحّح مع بعض
const attemptCount = Number(arg('attempts', 0)) || null;
// `.filter(Boolean)` **قبل** التحويل لرقم: `Number('')` بيساوي صفر مش NaN، فالقيمة
// الفاضية كانت بتعدّي كرقم صحيح وتولّد `AND a.id IN (0)` — استعلام بيرجع صفر صف
// من غير أي رسالة خطأ
// **سؤال بعينه في كل الأوراق** — الحالة دي بتحصل لما إجابة مرجعية تتصلّح: السؤال ده
// بس هو اللي محتاج يتعاد، والورق كله محتاج يتعاد بيه عشان الطلبة يتحاسبوا بمعيار واحد.
// `--q-no` بيتكلم بترقيم الامتحان اللي الموظف شايفه (١ لأول سؤال)، و`--question-ids`
// بمعرّفات القاعدة. الترقيم بيتحوّل هنا مرة واحدة بدل ما حد يعدّه بإيده ويغلط
const questionNo = Number(arg('q-no', 0)) || null;
const questionIds = String(arg('question-ids', '') || '')
  .split(',').map((part) => part.trim()).filter(Boolean)
  .map(Number).filter((id) => Number.isInteger(id) && id > 0);
const attemptIds = String(arg('attempt-ids', '') || '')
  .split(',').map((part) => part.trim()).filter(Boolean)
  .map(Number).filter((id) => Number.isInteger(id) && id > 0);
const imagesOnly = flag('images-only');
// --all بتسحب المقالي كله حتى المتصحّح — لإعادة تصحيح اختبار قديم بمعيار جديد
const all = flag('all');

// **درجات الموظف مستثناة دايمًا** (`graded_by <> 'staff'`) حتى مع --all: إعادة التصحيح
// بتصلّح شغل النموذج، مابتلغيش حكم بني آدم — نفس قاعدة queueQuizRegrade بالظبط
const SQL = `
SELECT COALESCE(json_agg(t ORDER BY t.attempt_id, t.question_id), '[]'::json)::text FROM (
  SELECT an.attempt_id, an.question_id, q.points::float8 AS points,
         COALESCE(p.text, '') AS parent_text, q.label, COALESCE(q.text, '') AS text,
         COALESCE(q.reference_answer, '') AS reference_answer,
         COALESCE(q.grading_notes, '') AS grading_notes,
         COALESCE(an.essay_text, '') AS essay_text,
         an.answer_image_path
  FROM quiz_answers an
  JOIN quiz_attempts a ON a.id = an.attempt_id
  JOIN quiz_questions q ON q.id = an.question_id
  LEFT JOIN quiz_questions p ON p.id = q.parent_id
  WHERE a.quiz_id = ${quizId}
    ${questionIds.length ? `AND q.id IN (${questionIds.join(',')})` : ''}
    ${questionNo ? `AND q.position = ${questionNo - 1}` : ''}
    ${attemptIds.length ? `AND a.id IN (${attemptIds.join(',')})` : ''}
    ${attemptCount ? `AND a.id IN (
      -- **عيّنة موزّعة مش أول عشرة.** الترتيب بالـid بياخد أقدم الأوراق كلها، وأول
      -- اللي سلّموا مش عيّنة ممثّلة. md5 بيوزّع عشوائيًا بس بشكل ثابت — نفس الأمر
      -- بيرجّع نفس الأوراق، فالتقرير يتعاد ويتراجع
      SELECT id FROM quiz_attempts
      WHERE quiz_id = ${quizId} AND submitted_at IS NOT NULL AND grading_status = 'graded'
      ORDER BY md5(id::text) LIMIT ${attemptCount}
    )` : ''}
    AND q.kind = 'essay'
    AND a.submitted_at IS NOT NULL
    AND an.graded_by <> 'staff'
    ${all ? '' : 'AND an.awarded_points IS NULL'}
    ${imagesOnly ? 'AND an.answer_image_path IS NOT NULL' : ''}
  ${limit ? `LIMIT ${limit}` : ''}
) t;`;

const dir = quizWorkDir(quizId);
const imagesDir = path.join(dir, 'images');
fs.mkdirSync(imagesDir, { recursive: true });

if ((questionNo || questionIds.length) && all) {
  console.log('⚠️ سحب سؤال بعينه مع --all: ده لإعادة تصحيح سؤال اتصلّح مرجعه.');
  console.log('   الرفع بعد كده محتاج --overwrite عشان الدرجة الموجودة تتغيّر.');
}
console.log(`⏳ بيجيب قايمة الإجابات من الإنتاج (اختبار ${quizId})...`);
const rows = psqlJson(SQL) || [];
if (!rows.length) {
  console.log('✅ مفيش إجابة مستنية تصحيح. مفيش حاجة تتعمل.');
  process.exit(0);
}

// الصور السحابية مالهاش مسار على القرص — بتتساب للمراجعة اليدوية، نفس ما readAnswerImage
// بيعمل في مسار الـAPI. الأداة بتقول العدد بدل ما تسكت
const cloud = rows.filter((r) => r.answer_image_path && /^https?:\/\//i.test(r.answer_image_path));
const local = rows.filter((r) => r.answer_image_path && !/^https?:\/\//i.test(r.answer_image_path));

const items = rows.map((r) => ({
  ...r,
  image_file: r.answer_image_path && !/^https?:\/\//i.test(r.answer_image_path)
    ? path.basename(r.answer_image_path) : null,
}));

console.log(`   ${items.length} إجابة · ${local.length} بصورة محلية · ${cloud.length} صورتها على السحابة (هتتساب)`);

// ---------- تنزيل الصور ----------
//
// **scp بدفعات مش ملف ملف.** ١٥٠٠ ملف = ١٥٠٠ جلسة ssh، والفرق دقايق مقابل ساعة.
// الأقواس بتتفك على السيرفر نفسه، فالدفعة كلها بتنزل في اتصال واحد.
const needed = [...new Set(local.map((r) => r.answer_image_path))]
  .filter((p) => !fs.existsSync(path.join(imagesDir, path.basename(p))));

if (needed.length) {
  const CHUNK = 60;
  let done = 0;
  for (let i = 0; i < needed.length; i += CHUNK) {
    const chunk = needed.slice(i, i + CHUNK);
    const remote = chunk.length === 1
      ? `${REMOTE_APP}/public/${chunk[0]}`
      : `${REMOTE_APP}/public/{${chunk.join(',')}}`;
    const result = spawnSync('scp', sshArgs(['-q', `${SSH_HOST}:${remote}`, imagesDir]), { encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(`⚠️ دفعة صور فشلت (${i}-${i + chunk.length}): ${(result.stderr || '').trim().slice(0, 300)}`);
    }
    done += chunk.length;
    process.stdout.write(`\r⏳ صور: ${done}/${needed.length}`);
  }
  process.stdout.write('\n');
} else {
  console.log('   كل الصور موجودة محليًا خلاص.');
}

// اللي صورته مانزلتش بتتعلّم — grade.js بيتعامل معاها كإجابة نص (أو بيتخطّاها لو مفيش نص)
let missing = 0;
for (const item of items) {
  if (item.image_file && !fs.existsSync(path.join(imagesDir, item.image_file))) {
    item.image_file = null;
    item.image_missing = true;
    missing += 1;
  }
}

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  quiz_id: quizId, pulled_at: new Date().toISOString(), count: items.length, items,
}, null, 2), 'utf8');

console.log(`\n✅ اتكتب ${path.join(dir, 'manifest.json')}`);
console.log(`   ${items.length} إجابة جاهزة للتصحيح${missing ? ` · ${missing} صورتها مانزلتش` : ''}`);
console.log(`\nالخطوة اللي بعدها:\n   node tools/local-grader/grade.js --quiz ${quizId}`);
