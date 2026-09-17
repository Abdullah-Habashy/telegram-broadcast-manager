// ---------- مقارنة التصحيح المحلي بالتصحيح اللي في الإنتاج ----------
//
//   node tools/local-grader/compare.js --quiz 14 [--top 8] [--json out.json]
//
// **قراءة فقط.** بيقرا `results.jsonl` وبيجيب الدرجات الحالية من الإنتاج وبيقول
// اتفقوا فين واختلفوا فين — قبل ما تقرر ترفع أصلًا.
//
// السؤال اللي بيجاوب عليه: «هل أسيب التصحيح ده يكتب فوق اللي موجود؟». الرقم اللي
// يهم مش نسبة الاتفاق لوحدها، ده **اتجاه الاختلاف**: لو الجديد بيدّي أعلى دايمًا،
// يبقى فيه انحراف مش تشويش عشوائي، وده قرار مختلف تمامًا.

const fs = require('fs');
const path = require('path');
const { psqlJson, quizWorkDir } = require('./config');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] || true);
}

const quizId = Number(arg('quiz'));
if (!Number.isInteger(quizId) || quizId <= 0) {
  console.error('لازم --quiz <رقم الاختبار>');
  process.exit(1);
}
const topN = Number(arg('top', 8)) || 8;
const jsonOut = arg('json', null);

const dir = quizWorkDir(quizId);
const manifestPath = path.join(dir, 'manifest.json');
const resultsPath = path.join(dir, 'results.jsonl');
if (!fs.existsSync(manifestPath) || !fs.existsSync(resultsPath)) {
  console.error(`مفيش نتايج في ${dir}. شغّل pull.js وبعده grade.js الأول.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const meta = new Map(manifest.items.map((item) => [`${item.attempt_id}:${item.question_id}`, item]));

const latest = new Map();
for (const line of fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean)) {
  try {
    const row = JSON.parse(line);
    latest.set(`${row.attempt_id}:${row.question_id}`, row);
  } catch { /* سطر ناقص من كتابة اتقطعت */ }
}

const rows = [...latest.values()].filter((row) => meta.has(`${row.attempt_id}:${row.question_id}`));
if (!rows.length) {
  console.error('مفيش نتيجة محلية تتقارن.');
  process.exit(1);
}

const pairs = rows.map((row) => `(${row.attempt_id},${row.question_id})`).join(',');
const attemptIds = [...new Set(rows.map((row) => row.attempt_id))];

const old = psqlJson(`
SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (
  SELECT an.attempt_id, an.question_id, an.ai_verdict, an.awarded_points::float8 AS awarded,
         an.graded_by, an.ai_provider, COALESCE(an.ai_reason, '') AS ai_reason
  FROM quiz_answers an
  WHERE (an.attempt_id, an.question_id) IN (${pairs})
) t;`) || [];

const attempts = psqlJson(`
SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (
  SELECT a.id, COALESCE(a.student_name, '') AS student_name,
         a.score::float8 AS score, a.max_score::float8 AS max_score
  FROM quiz_attempts a WHERE a.id IN (${attemptIds.join(',')})
) t;`) || [];

const oldByKey = new Map(old.map((row) => [`${row.attempt_id}:${row.question_id}`, row]));
const attemptByid = new Map(attempts.map((row) => [row.id, row]));

// ---------- المقارنة سؤال سؤال ----------
const compared = [];
for (const row of rows) {
  const key = `${row.attempt_id}:${row.question_id}`;
  const before = oldByKey.get(key);
  if (!before || before.awarded === null) continue;
  const points = Number(meta.get(key).points);
  const after = Number((points * row.score_ratio).toFixed(2));
  compared.push({
    attempt_id: row.attempt_id,
    question_id: row.question_id,
    points,
    old_verdict: before.ai_verdict,
    new_verdict: row.verdict,
    old_score: Number(before.awarded),
    new_score: after,
    delta: Number((after - Number(before.awarded)).toFixed(2)),
    graded_by: before.graded_by,
    old_reason: before.ai_reason,
    new_reason: row.reason,
  });
}

if (!compared.length) {
  console.error('مفيش سؤال متصحّح قبل كده يتقارن بيه.');
  process.exit(1);
}

const same = compared.filter((c) => c.delta === 0);
const higher = compared.filter((c) => c.delta > 0);
const lower = compared.filter((c) => c.delta < 0);
const sameVerdict = compared.filter((c) => c.old_verdict === c.new_verdict);
const staff = compared.filter((c) => c.graded_by === 'staff');
const absAvg = compared.reduce((sum, c) => sum + Math.abs(c.delta), 0) / compared.length;
const netTotal = compared.reduce((sum, c) => sum + c.delta, 0);

const pct = (n) => `${Math.round((n / compared.length) * 100)}%`;
const sign = (n) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

console.log(`\n═══ مقارنة التصحيح المحلي بالموجود — اختبار ${quizId} ═══\n`);
console.log(`  ${compared.length} سؤال على ${attemptIds.length} ورقة\n`);
console.log(`  الدرجة زي ما هي     ${String(same.length).padStart(4)}  ${pct(same.length)}`);
console.log(`  الجديد أعلى          ${String(higher.length).padStart(4)}  ${pct(higher.length)}`);
console.log(`  الجديد أقل           ${String(lower.length).padStart(4)}  ${pct(lower.length)}`);
console.log(`  نفس الحكم (verdict)  ${String(sameVerdict.length).padStart(4)}  ${pct(sameVerdict.length)}`);
console.log(`\n  متوسط فرق السؤال     ${absAvg.toFixed(3)} درجة`);
console.log(`  صافي الفرق الكلي     ${sign(netTotal)} درجة`
  + (Math.abs(netTotal) < 0.01 ? '' : netTotal > 0 ? '  ← الجديد أكرم' : '  ← الجديد أقسى'));
if (staff.length) {
  console.log(`\n  ⚠️ ${staff.length} سؤال منهم درجته من موظف بإيده — push بيتخطّاهم ومابيلمسهمش`);
}

// ---------- الورقة ككل ----------
//
// الفرق في سؤال واحد ممكن يبقى ربع درجة ومايفرقش، لكن لو الفروق بتتجمّع في اتجاه
// واحد على نفس الورقة بيبقى الفرق في المجموع حقيقي — والطالب هو اللي بيحس بده
console.log('\n─── الورقة ككل ───\n');
console.log('  (الأسئلة المقارَنة مقالي بس — عمود «الورقة» هو مجموع الورقة كلها بالاختياري)\n');
console.log('  ورقة    الطالب                مقالي قديم  مقالي جديد   الفرق      الورقة');
const perAttempt = attemptIds.map((id) => {
  const mine = compared.filter((c) => c.attempt_id === id);
  const oldSum = mine.reduce((sum, c) => sum + c.old_score, 0);
  const newSum = mine.reduce((sum, c) => sum + c.new_score, 0);
  const attempt = attemptByid.get(id) || {};
  return {
    id,
    name: String(attempt.student_name || '—').slice(0, 20),
    questions: mine.length,
    old_total: Number(oldSum.toFixed(2)),
    new_total: Number(newSum.toFixed(2)),
    delta: Number((newSum - oldSum).toFixed(2)),
    paper_score: attempt.score,
    max_score: attempt.max_score,
  };
}).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

for (const row of perAttempt) {
  const mark = row.delta === 0 ? '  ' : row.delta > 0 ? '▲ ' : '▼ ';
  // درجة الورقة كلها قبل وبعد: الفرق في المقالي بيتنقل بالكامل على المجموع، لأن
  // الاختياري مابيتلمسش — وده الرقم اللي الطالب بيشوفه فعلًا
  const paper = Number(row.paper_score);
  const paperAfter = Number.isFinite(paper) ? (paper + row.delta) : null;
  const paperCell = paperAfter === null ? ''
    : `   ${paper.toFixed(2)} → ${paperAfter.toFixed(2)} / ${row.max_score}`;
  console.log(`  #${String(row.id).padEnd(7)}${row.name.padEnd(22)}`
    + `${row.old_total.toFixed(2).padStart(9)}  ${row.new_total.toFixed(2).padStart(10)}`
    + `   ${mark}${sign(row.delta).padStart(6)}${paperCell}`);
}

// ---------- أكبر الاختلافات بالنص ----------
//
// الأرقام بتقول فيه اختلاف، والنص بس هو اللي بيقول مين فيهم على حق
const worst = compared.filter((c) => c.delta !== 0)
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, topN);

if (worst.length) {
  console.log(`\n─── أكبر ${worst.length} اختلاف، بالنص ───`);
  for (const c of worst) {
    console.log(`\n  ورقة #${c.attempt_id} · سؤال ${c.question_id} · من ${c.points} درجة`);
    console.log(`     قديم: ${c.old_verdict} ${c.old_score}  →  جديد: ${c.new_verdict} ${c.new_score}   (${sign(c.delta)})`);
    console.log(`     قال قديمًا : ${c.old_reason.replace(/\s+/g, ' ').slice(0, 150)}`);
    console.log(`     قال جديدًا : ${c.new_reason.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    quiz_id: quizId,
    compared: compared.length,
    attempts: perAttempt,
    summary: {
      same: same.length, higher: higher.length, lower: lower.length,
      same_verdict: sameVerdict.length, avg_abs_delta: Number(absAvg.toFixed(3)),
      net_delta: Number(netTotal.toFixed(2)),
    },
    questions: compared,
  }, null, 2), 'utf8');
  console.log(`\n📄 التفاصيل كاملة في ${jsonOut}`);
}

console.log('\n(مفيش حاجة اتغيّرت — ده عرض بس.)');
