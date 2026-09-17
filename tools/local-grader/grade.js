// ---------- تصحيح الدفعة محليًا بـ Claude Code ----------
//
//   node tools/local-grader/grade.js --quiz 14 [--batch 8] [--model sonnet] [--limit 50] [--show-prompt]
//
// **ليه دفعات مش سؤال سؤال:** كل نداء لـ`claude -p` بيحمّل تعليمات Claude Code وأدواته
// قبل أي شغل. اتقاس على إجابات حقيقية: سؤال لوحده = $0.265 بسعر القايمة و٦٥ ثانية،
// وتلاتة في نداء واحد = $0.10 للسؤال. الحمل الثابت ~$0.25 للنداء والزيادة الحقيقية
// ~$0.018 للسؤال — يعني كل ما الدفعة تكبر، التكلفة تقرب من الـAPI. ٨ اختيار وسط بين
// التوفير وبين إن فشل نداء واحد مايضيّعش شغل كتير.
//
// **الفلوس صفر على الاشتراك** — الأرقام دي بسعر القايمة، بتتحسب من حد الاستخدام مش من جيبك.
//
// **بيكمّل من مكانه.** كل إجابة اتصححت بتتكتب في `results.jsonl` أول ما ترجع، فقفل
// الجهاز أو نفاد حد الاستخدام مابيضيّعش اللي فات.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { quizWorkDir } = require('./config');
const {
  buildSystemPrompt, buildUserText, normalizeGrade, questionTextForGrading,
} = require('../../src/utils/quizGradingRules');

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
const batchSize = Math.max(1, Number(arg('batch', 8)) || 8);
const model = String(arg('model', 'sonnet'));
const maxItems = Number(arg('limit', 0)) || null;
const cooldownMs = (Number(arg('cooldown', 45)) || 45) * 1000;
const limitWaitMs = (Number(arg('limit-wait', 900)) || 900) * 1000;
const maxLimitWaits = Number(arg('limit-retries', 8)) || 8;

const dir = quizWorkDir(quizId);
const imagesDir = path.join(dir, 'images');
const manifestPath = path.join(dir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`مفيش manifest. شغّل الأول:\n   node tools/local-grader/pull.js --quiz ${quizId}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const resultsPath = path.join(dir, 'results.jsonl');
const failedPath = path.join(dir, 'failed.jsonl');

const key = (item) => `${item.attempt_id}:${item.question_id}`;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const done = new Set(readJsonl(resultsPath).map(key));
let pending = manifest.items.filter((item) => !done.has(key(item)));
// إجابة من غير نص ومن غير صورة مش شغل نموذج — القاعدة في quizScoring بتديها صفر
// "ساب السؤال فاضي" من غير نداء، والأداة بتمشي على نفس القاعدة بدل ما تدفع توكنز فيها
const blankSet = new Set(pending
  .filter((item) => !String(item.essay_text || '').trim() && !item.image_file)
  .map(key));
const blank = pending.filter((item) => blankSet.has(key(item)));
pending = pending.filter((item) => !blankSet.has(key(item)));
if (maxItems) pending = pending.slice(0, maxItems);

console.log(`📋 اختبار ${quizId}: ${manifest.items.length} إجمالي · ${done.size} اتصححوا · ${pending.length} مستنيين`
  + (blank.length ? ` · ${blank.length} فاضيين (صفر تلقائي)` : ''));

if (blank.length) {
  const lines = blank.map((item) => JSON.stringify({
    attempt_id: item.attempt_id,
    question_id: item.question_id,
    verdict: 'incorrect',
    score_ratio: 0,
    reason: 'ساب السؤال فاضي',
    model: null,
    at: new Date().toISOString(),
  }));
  fs.appendFileSync(resultsPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`   ✅ ${blank.length} إجابة فاضية اتسجّلت صفر من غير نداء للنموذج`);
}
if (!pending.length) {
  console.log('\n✅ خلاص، مفيش حاجة مستنية. الخطوة اللي بعدها:');
  console.log(`   node tools/local-grader/push.js --quiz ${quizId}`);
  process.exit(0);
}

// ---------- بناء الرسالة ----------
//
// البرومبت بيتبني من `src/utils/quizGradingRules.js` — نفس الملف اللي مسار الـAPI بيقرا
// منه. **متكتبش قواعد تصحيح هنا**: أي قاعدة تتكتب في الملف ده بس هتخلي الطالب اللي
// اتصحح محليًا يتحاسب بمعيار غير زميله.
//
// السؤال والمرجع بيتحطوا مع كل إجابة تحت مش في الـsystem، فبنمرّر إشارة لمكانهم —
// بالشكل ده القواعد نصًا نفس النص، والاختلاف الوحيد إن الدفعة فيها أكتر من سؤال
const SYSTEM_PROMPT = buildSystemPrompt(
  'كل إجابة في الرسالة تحت جاية ومعاها سؤالها برقمه.',
  'كل إجابة في الرسالة تحت جاية ومعاها إجابتها المرجعية. مرجع كل سؤال هو الحقيقة الوحيدة ليه، ومايتخلطش بمرجع سؤال تاني.',
  '');

const IMAGE_RULES = buildUserText({ studentAnswer: '', hasImage: true });

function buildBatchPrompt(batch) {
  const hasImages = batch.some((item) => item.image_file);
  const blocks = batch.map((item, index) => {
    const lines = [`=== إجابة رقم ${index + 1} ===`, `درجة السؤال: ${item.points}`];
    const text = questionTextForGrading(item);
    lines.push('السؤال:', text || '(نص السؤال نفسه في صورة مرفقة بالاختبار — احكم من الإجابة المرجعية)');
    lines.push('الإجابة المرجعية:', item.reference_answer || '(مفيش مرجع — حط incorrect و0 وقول للطالب إن السؤال محتاج مراجعة موظف)');
    if (String(item.grading_notes || '').trim()) {
      lines.push(
        'تعليمات إضافية من الموظف للسؤال ده بالذات (بتضيف شرط على المعنى، ومابتلغيش قواعد الإملا والصياغة واللغة):',
        item.grading_notes,
      );
    }
    if (item.image_file) {
      lines.push(`إجابة الطالب في الصورة دي — اقراها بأداة Read:\n${path.join(imagesDir, item.image_file)}`);
      if (String(item.essay_text || '').trim()) lines.push(`وكتب معاها:\n${item.essay_text}`);
    } else {
      lines.push(`إجابة الطالب:\n${item.essay_text}`);
    }
    return lines.join('\n');
  });

  return [
    `صحّح الـ${batch.length} إجابة دي، كل واحدة لوحدها بمرجعها هي.`,
    hasImages ? `\n${IMAGE_RULES}\n` : '',
    blocks.join('\n\n'),
    '',
    '=== المطلوب منك ===',
    `رجّع مصفوفة JSON بس، من غير أي كلام قبلها أو بعدها، فيها ${batch.length} عنصر بنفس الترتيب:`,
    '[{"n": 1, "verdict": "correct" أو "partial" أو "incorrect", "score_ratio": رقم من 0 لـ 1, "reason": "كلامك للطالب نفسه بالعامية المصرية بصيغة المخاطب، جملة أو جملتين"}]',
    'لازم ترجّع عنصر لكل إجابة حتى لو مش متأكد. متكتبش أي شرح بره الـJSON.',
  ].filter(Boolean).join('\n');
}

// النموذج بيلف الـJSON في ```json ساعات. بناخد أول [ لآخر ] بدل ما نعتمد على شكل التغليف
function extractArray(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

const LIMIT_PATTERN = /usage limit|rate limit|quota|too many requests|overloaded|limit reached/i;

function runClaude(prompt) {
  const result = spawnSync('claude', [
    '-p', '--output-format', 'json', '--model', model,
    '--system-prompt', SYSTEM_PROMPT,
    '--allowedTools', 'Read',
    '--add-dir', imagesDir,
  ], { input: prompt, encoding: 'utf8', cwd: imagesDir, maxBuffer: 64 * 1024 * 1024 });

  if (result.error) return { ok: false, limited: false, error: result.error.message };
  const stderr = (result.stderr || '').trim();
  if (result.status !== 0) {
    return { ok: false, limited: LIMIT_PATTERN.test(stderr), error: `claude رجع ${result.status}: ${stderr.slice(0, 300)}` };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { ok: false, limited: false, error: 'مخرج claude مش JSON' };
  }
  if (payload.is_error || payload.subtype !== 'success') {
    const message = String(payload.result || payload.api_error_status || 'فشل غير معروف');
    return { ok: false, limited: LIMIT_PATTERN.test(message), error: message.slice(0, 300) };
  }
  return { ok: true, text: payload.result, usd: Number(payload.total_cost_usd) || 0 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (flag('show-prompt')) {
    console.log('\n──────── البرومبت الثابت ────────\n');
    console.log(SYSTEM_PROMPT);
    console.log('\n──────── رسالة أول دفعة ────────\n');
    console.log(buildBatchPrompt(pending.slice(0, batchSize)));
    return;
  }

  const batches = [];
  for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));

  console.log(`\n▶️ ${batches.length} دفعة × ${batchSize} · النموذج ${model}\n`);
  const startedAt = Date.now();
  let graded = 0;
  let failed = 0;
  let usd = 0;

  for (const [index, batch] of batches.entries()) {
    const prompt = buildBatchPrompt(batch);
    let outcome = null;
    // **الانتظار على حد الاستخدام له سقف.** من غيره، حد مش بيفضى (اشتراك خلص مثلًا)
    // كان بيخلي السكربت يستنى للأبد من غير ما يقول ليه — والشغل اللي فات محفوظ أصلًا
    // في results.jsonl فالوقوف مش خسارة
    let limitWaits = 0;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      outcome = runClaude(prompt);
      if (outcome.ok && extractArray(outcome.text)) break;
      if (!outcome.ok && outcome.limited && limitWaits < maxLimitWaits) {
        limitWaits += 1;
        const minutes = Math.round(limitWaitMs / 60000);
        console.log(`   ⏸️ وصلنا حد الاستخدام (${limitWaits}/${maxLimitWaits}) — مستني ${minutes} دقيقة وبكمّل من نفس المكان.`);
        await sleep(limitWaitMs);
        attempt -= 1; // حد الاستخدام مش فشل في الشغل، فمايتحسبش من المحاولات التلاتة
        continue;
      }
      if (attempt < 3) {
        console.log(`   ↻ محاولة ${attempt} فشلت (${outcome.error || 'ناتج مش مفهوم'}) — إعادة بعد ${cooldownMs / 1000}ث`);
        await sleep(cooldownMs);
      }
    }

    usd += outcome.usd || 0;
    const parsed = outcome.ok ? extractArray(outcome.text) : null;
    if (!parsed) {
      failed += batch.length;
      const lines = batch.map((item) => JSON.stringify({
        attempt_id: item.attempt_id,
        question_id: item.question_id,
        error: outcome.error || 'ناتج مش مفهوم',
        at: new Date().toISOString(),
      }));
      fs.appendFileSync(failedPath, `${lines.join('\n')}\n`, 'utf8');
      console.log(`⚠️ دفعة ${index + 1}/${batches.length} فشلت (${batch.length} إجابة) — اتسجّلت في failed.jsonl`);
      continue;
    }

    // **الربط بالرقم مش بالترتيب.** لو النموذج قلب الترتيب أو نقص عنصر، المطابقة
    // بالترتيب كانت هتدّي درجة طالب لطالب تاني — أسوأ عطل ممكن في الأداة دي
    const byNumber = new Map(parsed
      .filter((row) => row && Number.isInteger(Number(row.n)))
      .map((row) => [Number(row.n), row]));
    const lines = [];
    const missed = [];
    batch.forEach((item, position) => {
      const grade = normalizeGrade(byNumber.get(position + 1));
      if (!grade) { missed.push(item); return; }
      lines.push(JSON.stringify({
        attempt_id: item.attempt_id,
        question_id: item.question_id,
        verdict: grade.verdict,
        score_ratio: grade.score_ratio,
        reason: grade.reason,
        model,
        at: new Date().toISOString(),
      }));
    });
    if (lines.length) fs.appendFileSync(resultsPath, `${lines.join('\n')}\n`, 'utf8');
    if (missed.length) {
      const missedLines = missed.map((item) => JSON.stringify({
        attempt_id: item.attempt_id,
        question_id: item.question_id,
        error: 'النموذج ماردّش على الإجابة دي في الدفعة',
        at: new Date().toISOString(),
      }));
      fs.appendFileSync(failedPath, `${missedLines.join('\n')}\n`, 'utf8');
    }
    graded += lines.length;
    failed += missed.length;

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = graded / Math.max(elapsed, 1);
    const left = pending.length - graded - failed;
    const eta = rate > 0 ? Math.round(left / rate / 60) : 0;
    console.log(`✅ دفعة ${index + 1}/${batches.length} · ${lines.length}/${batch.length}`
      + `${missed.length ? ` (${missed.length} ماردّش عليهم)` : ''}`
      + ` · إجمالي ${graded} · باقي ~${eta}د · بسعر القايمة $${usd.toFixed(2)}`);
  }

  console.log(`\n✅ خلص: ${graded} اتصححوا${failed ? ` · ${failed} فشلوا` : ''}`);
  console.log(`   الاستهلاك بسعر القايمة $${usd.toFixed(2)} — مدفوع من الاشتراك مش من رصيد الـAPI`);
  if (failed) console.log(`   الفاشلين في ${failedPath} — شغّل الأمر تاني وهياخدهم من الأول`);
  console.log(`\nالخطوة اللي بعدها:\n   node tools/local-grader/push.js --quiz ${quizId}`);
})();
