const cron = require('node-cron');
const pool = require('../config/db');
const { finalizeAttempt, processRegradeQueue, queueLength } = require('../utils/quizScoring');
const { sendPendingResults } = require('./quizResultNotifier');

// ---------- إقفال المحاولات اللي وقتها خلص ----------
//
// **ليه وظيفة مش مجرد تسليم من المتصفح:** التسليم التلقائي عند صفر بيتنفّذ في صفحة الطالب،
// فأي طالب قفل التاب أو نفدت بطاريته أو قطع النت قبل نهاية الوقت كانت محاولته هتفضل مفتوحة
// للأبد والموظف يشوفها "لسه بيحل" بعد أسبوع. الوظيفة بتصحّح اللي كان محفوظ (الحفظ التلقائي
// بيكتب كل شوية) وتقفلها.
//
// دقيقتين سماح بعد الميعاد: التسليم من المتصفح بيوصل متأخر ثواني على النت البطيء، والسباق
// بين الاتنين مش مشكلة (finalizeAttempt آمنة للنداء أكتر من مرة) بس مفيش داعي نستعجله

const GRACE_MINUTES = 2;
const BATCH_SIZE = 20;
// سقف الدورات في التشغيلة الواحدة: ٢٠ محاولة × ١٠٠ دورة = ٢٠٠٠ ورقة في التشغيلة،
// وبعدها الكرون بيكمّل. موجود عشان خلل يرجّع الصفوف للطابور مايعملش لوب أبدي
const MAX_DRAIN_ROUNDS = 100;

let running = false;

async function finalizeExpiredAttempts() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM quiz_attempts
       WHERE submitted_at IS NULL AND deadline_at IS NOT NULL
         AND deadline_at < NOW() - ($1 || ' minutes')::interval
       ORDER BY deadline_at LIMIT $2`, [String(GRACE_MINUTES), BATCH_SIZE]);

    for (const row of rows) {
      try {
        await finalizeAttempt(row.id);
        console.log(`⏱️ Closed quiz attempt #${row.id} after its time ran out.`);
      } catch (error) {
        // فشل التصحيح الآلي مابيوقفش باقي المحاولات — كل واحدة مستقلة عن التانية
        console.error(`❌ Failed to close expired quiz attempt #${row.id}:`, error.message);
      }
    }

    // ---------- تصريف طابور التصحيح ----------
    // **بيفضل ماشي لحد ما الطابور يفضى، مش دفعة واحدة كل تشغيلة.** بدفعة واحدة كل
    // دقيقتين، امتحان ٥٠٠٠ طالب كان هياخد أيام. علم `running` فوق بيمنع تشغيلتين مع بعض،
    // فالتصريف الطويل آمن — التشغيلة اللي بعده بترجع من غير ما تعمل حاجة.
    // السقف عشان تشغيلة واحدة ماتفضلش شغالة للأبد لو حصل خلل بيرجّع الصفوف للطابور
    let drained = 0;
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
      const outcome = await processRegradeQueue(BATCH_SIZE);
      drained += outcome.processed;
      if (!outcome.remaining || !outcome.processed) break;
    }
    if (drained) {
      console.log(`🔁 Graded ${drained} queued quiz attempt(s); ${await queueLength()} left in the queue.`);
    }

    // الإشعار في نفس التشغيلة بعد التصحيح مباشرة — مش كرون تاني. الدرجة بتخلص هنا،
    // فأقرب لحظة يوصل فيها الإشعار هي اللي بعدها على طول، والعلم running فوق بيمنع
    // التداخل. فشله مابيوقفش التصحيح — الدرجة متسجّلة والطالب يقدر يفتح الرابط بنفسه
    await sendPendingResults();
  } catch (error) {
    console.error('❌ Failed to run the quiz finalizer:', error.message);
  } finally {
    running = false;
  }
}

function startQuizFinalizer() {
  // كل دقيقة مش كل دقيقتين: الطالب مستني درجته، والعلم `running` بيمنع التداخل
  cron.schedule('* * * * *', () => {
    finalizeExpiredAttempts().catch((err) => console.error('❌ Failed to run quiz finalizer:', err.message));
  });
  console.log('✅ Quiz finalizer scheduler started; draining the grading queue every minute.');
}

module.exports = { startQuizFinalizer, finalizeExpiredAttempts };
