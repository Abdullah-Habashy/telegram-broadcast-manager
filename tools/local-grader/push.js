// ---------- رفع نتايج التصحيح المحلي للإنتاج ----------
//
//   node tools/local-grader/push.js --quiz 14            # تجربة بس، مابتغيّرش حاجة
//   node tools/local-grader/push.js --quiz 14 --apply     # التنفيذ الفعلي
//
// **التجربة هي الافتراضي.** السكربت ده بيكتب درجات طلبة حقيقيين في الإنتاج، فالتشغيل
// من غير `--apply` بيلف كل حاجة في BEGIN/ROLLBACK وبيوريك هيتأثر كام صف من غير ما يغيّر.

const fs = require('fs');
const path = require('path');
const { psqlJson, quizWorkDir } = require('./config');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] || true);
}
const apply = process.argv.includes('--apply');

const quizId = Number(arg('quiz'));
if (!Number.isInteger(quizId) || quizId <= 0) {
  console.error('لازم --quiz <رقم الاختبار>');
  process.exit(1);
}

const dir = quizWorkDir(quizId);
const manifestPath = path.join(dir, 'manifest.json');
const resultsPath = path.join(dir, 'results.jsonl');
if (!fs.existsSync(manifestPath) || !fs.existsSync(resultsPath)) {
  console.error(`مفيش نتايج في ${dir}. شغّل pull.js وبعده grade.js الأول.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const points = new Map(manifest.items.map((item) => [`${item.attempt_id}:${item.question_id}`, Number(item.points)]));

const results = fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

// **آخر نتيجة هي اللي تكسب.** الملف append-only، فإعادة تصحيح سؤال بتضيف سطر جديد
// تحت القديم بدل ما تستبدله — من غير التوحيد ده كان هيتكتب الحكم القديم فوق الجديد
const latest = new Map();
for (const row of results) latest.set(`${row.attempt_id}:${row.question_id}`, row);

const rows = [...latest.values()].filter((row) => points.has(`${row.attempt_id}:${row.question_id}`));
if (!rows.length) {
  console.error('مفيش نتيجة صالحة للرفع.');
  process.exit(1);
}

const escape = (value) => String(value).replace(/'/g, "''");

const values = rows.map((row) => {
  const maxPoints = points.get(`${row.attempt_id}:${row.question_id}`);
  // نفس التقريب اللي الطالب بيتحسب بيه في finalizeAttempt بالظبط
  const awarded = Number((maxPoints * row.score_ratio).toFixed(2));
  return `(${row.attempt_id}, ${row.question_id}, ${awarded}, ${awarded >= maxPoints}, `
    + `'${escape(row.verdict)}', '${escape(row.reason)}', '${escape(row.model || 'claude-code')}')`;
}).join(',\n    ');

const attemptIds = [...new Set(rows.map((row) => row.attempt_id))];

// **مفيش توكنز بتتكتب عن قصد.** `aiPricing.costSql` بيحسب التكلفة من أعمدة التوكنز،
// وسيبها NULL معناها تكلفة صفر جنب الورقة — وده الصح فعلًا: الشغل ده اتدفع من الاشتراك
// مش من رصيد الـAPI، وكتابة رقم فيها كان هيضيف تكلفة وهمية على تقرير الاختبار.
//
// و`graded_by` بيفضل `auto` لأنه فعلًا تصحيح نموذج — `staff` معناها بني آدم حط الدرجة
// بإيده، والفرق ده هو اللي بيحمي درجات الموظفين من إعادة التصحيح.
const SQL = `
BEGIN;

CREATE TEMP TABLE local_grades (
  attempt_id INTEGER, question_id INTEGER, awarded NUMERIC(6,2),
  is_correct BOOLEAN, verdict TEXT, reason TEXT, model TEXT
) ON COMMIT DROP;

INSERT INTO local_grades VALUES
    ${values};

UPDATE quiz_answers an SET
  awarded_points = g.awarded,
  is_correct = g.is_correct,
  ai_verdict = g.verdict,
  ai_reason = g.reason,
  ai_provider = 'claude-code',
  ai_model = g.model,
  graded_by = 'auto',
  graded_at = NOW(),
  input_tokens = NULL, output_tokens = NULL,
  cache_read_tokens = NULL, cache_write_tokens = NULL
FROM local_grades g
WHERE an.attempt_id = g.attempt_id AND an.question_id = g.question_id
  AND an.graded_by <> 'staff';

-- نفس منطق recalculateAttempt في src/utils/quizScoring.js بالحرف: المجموع من الإجابات،
-- والحالة partial طالما فيه سؤال من غير درجة، والطابور مابيتلمسش عشان الوظيفة ماتفوّتش ورقة
UPDATE quiz_attempts a SET
  score = COALESCE(s.total, 0),
  grading_status = CASE
    WHEN a.grading_status IN ('queued', 'regrading') THEN a.grading_status
    WHEN s.ungraded > 0 THEN 'partial' ELSE 'graded' END
FROM (
  SELECT attempt_id, SUM(awarded_points) AS total,
         COUNT(*) FILTER (WHERE awarded_points IS NULL) AS ungraded
  FROM quiz_answers WHERE attempt_id IN (${attemptIds.join(',')})
  GROUP BY attempt_id
) s
WHERE a.id = s.attempt_id;

SELECT json_build_object(
  'egabat', (SELECT COUNT(*) FROM quiz_answers an JOIN local_grades g
             ON an.attempt_id = g.attempt_id AND an.question_id = g.question_id
             WHERE an.ai_provider = 'claude-code'),
  'awrak', (SELECT COUNT(*) FROM quiz_attempts WHERE id IN (${attemptIds.join(',')})),
  'nakes', (SELECT COUNT(*) FROM quiz_attempts WHERE id IN (${attemptIds.join(',')}) AND grading_status = 'partial')
)::text;

${apply ? 'COMMIT;' : 'ROLLBACK;'}
`;

console.log(`📤 ${rows.length} درجة على ${attemptIds.length} ورقة${apply ? '' : '  (تجربة — مش هيتغيّر حاجة)'}`);

let summary;
try {
  summary = psqlJson(SQL);
} catch (error) {
  console.error(`❌ فشل: ${error.message}`);
  process.exit(1);
}
if (!summary) {
  console.error('❌ السيرفر ماردّش بملخص — الأغلب إن الاستعلام فشل. مفيش حاجة اتغيّرت.');
  process.exit(1);
}

console.log(`   ${summary.egabat} إجابة اتكتبت · ${summary.awrak} ورقة اتعاد حساب درجتها`
  + (summary.nakes ? ` · ${summary.nakes} لسه ناقصة أسئلة` : ''));

if (!apply) {
  console.log('\n↩️ اترجع كل حاجة (ROLLBACK). لو الأرقام دي مظبوطة، شغّل:');
  console.log(`   node tools/local-grader/push.js --quiz ${quizId} --apply`);
} else {
  console.log('\n✅ اتحفظ في الإنتاج.');
  console.log('   الدرجات دي تكلفتها صفر في تقرير الاختبار — اتصححت من الاشتراك مش من رصيد الـAPI.');
}
