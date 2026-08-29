const cron = require('node-cron');
const pool = require('../config/db');
const { finalizeAttempt } = require('../utils/quizScoring');

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
  } catch (error) {
    console.error('❌ Failed to run the quiz finalizer:', error.message);
  } finally {
    running = false;
  }
}

function startQuizFinalizer() {
  cron.schedule('*/2 * * * *', () => {
    finalizeExpiredAttempts().catch((err) => console.error('❌ Failed to run quiz finalizer:', err.message));
  });
  console.log('✅ Quiz finalizer scheduler started; checking every 2 minutes.');
}

module.exports = { startQuizFinalizer, finalizeExpiredAttempts };
