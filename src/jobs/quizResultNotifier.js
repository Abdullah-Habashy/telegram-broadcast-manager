const pool = require('../config/db');
const botManager = require('../bot/botManager');
const { isPermanentSendError } = require('../utils/telegramErrors');

// ---------- إشعار الطالب إن درجته جاهزة ----------
//
// **المشكلة اللي بيحلها:** صفحة الاختبار بتسأل عن الدرجة لدقيقتين وبعدها بتقول "افتح
// الرابط تاني بعد شوية". الطالب اللي قفل الصفحة **مش بيرجع** — والتصحيح اللي اتكتب له
// مايتقريش. الرسالة دي هي الحاجة الوحيدة اللي بترجّعه.
//
// **مابتتسجّلش في المحادثة عن قصد.** القاعدة في المشروع إن أي حاجة تتبعت للطالب شخصيًا
// بتقفل دوره وتشيل علامة "مستني رد" عن التذكرة. الإشعار ده مش رد على سؤاله — هو نتيجة
// فعل عمله هو، ولو اتحسب رد كان هيفضّي لون التذكرة من معناه لكل طالب حل اختبار.
//
// **مابتستناش وقت العمل.** الطالب لسه سلّم من دقيقة وقاعد مستني — نفس منطق تقرير الطالب
// اللي بيطلبه بنفسه، مش منطق رسالة الترحيب.

const BATCH_SIZE = 30;
const DELAY_MS = 250;

let running = false;

// الرابط بيتبني من PUBLIC_URL زي bot/handlers/studentReport.js بالحرف. محليًا PUBLIC_URL
// مسيّب فاضي عن قصد، وساعتها الرسالة بتتبعت من غير رابط بدل ما الطالب ياخد لينك مكسور
function quizLink(quiz) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/q/${quiz.slug || quiz.token}` : null;
}

// التصحيح بيبان للطالب حسب إعدادات الاختبار — والرسالة لازم تقول اللي هيلاقيه فعلًا،
// مش تعده بحاجة يفتح الرابط ومايلاقيهاش
function reviewIsVisible(row) {
  if (!row.show_answers_to_student) return false;
  return row.answers_after_close ? !row.is_open : true;
}

function buildMessage(row) {
  const name = (row.student_name || '').split(' ')[0];
  const hello = name ? `${name}، ` : '';
  const link = quizLink(row);

  if (!row.show_score_to_student) {
    return `${hello}إجاباتك في «${row.title}» اتصحّحت ✅\nالفريق هيعلن الدرجات.`;
  }

  const score = Math.round(Number(row.score) * 100) / 100;
  const head = `${hello}درجتك في «${row.title}» جاهزة: ${score} من ${Number(row.max_score)} 🎯`;
  if (!link) return head;
  return reviewIsVisible(row)
    ? `${head}\n\nتقدر تشوف تصحيح ورقتك سؤال سؤال من هنا:\n${link}\n(ادخل بنفس رقم الموبايل)`
    : `${head}\n\n${link}`;
}

// النتيجة بتتبعت مرة واحدة: result_notified_at هو العلم. الفشل الدائم (حاظر البوت،
// حساب متمسوح) بيتعلّم كإنه اتبعت — مافيش فايدة من إعادة المحاولة كل دقيقة للأبد،
// وده بالظبط اللي خلّى تذكرة #466 تحاول لشهور
async function sendPendingResults() {
  if (running) return;
  running = true;
  try {
    const bot = botManager.getBot();
    if (!bot) return;

    const { rows } = await pool.query(
      `SELECT a.id, a.score, a.max_score, s.telegram_chat_id, s.name AS student_name,
              q.title, q.slug, q.token, q.is_open,
              q.show_score_to_student, q.show_answers_to_student, q.answers_after_close
       FROM quiz_attempts a
       JOIN quizzes q ON q.id = a.quiz_id
       JOIN tafra_students s ON s.tafra_student_id = a.tafra_student_id
       WHERE a.result_notified_at IS NULL
         AND a.submitted_at IS NOT NULL
         AND a.grading_status IN ('graded', 'partial')
         AND s.telegram_chat_id IS NOT NULL
       ORDER BY a.submitted_at
       LIMIT $1`, [BATCH_SIZE]);

    for (const row of rows) {
      try {
        await bot.telegram.sendMessage(row.telegram_chat_id, buildMessage(row));
        await pool.query('UPDATE quiz_attempts SET result_notified_at = NOW() WHERE id = $1', [row.id]);
        console.log(`📨 Sent the quiz result for attempt #${row.id}.`);
      } catch (error) {
        if (isPermanentSendError(error)) {
          await pool.query('UPDATE quiz_attempts SET result_notified_at = NOW() WHERE id = $1', [row.id]);
          console.warn(`🚫 Gave up on the quiz result for attempt #${row.id}: ${error.message}`);
        } else {
          // مؤقت (شبكة، 429): بيفضل من غير علامة والتشغيلة الجاية بعد دقيقة بتعيد
          console.error(`❌ Failed to send the quiz result for attempt #${row.id}:`, error.message);
        }
      }
      // نفس فاصل welcomeMessageSender — تيليجرام بيرمي 429 على الدفعات السريعة
      await new Promise((resolve) => { setTimeout(resolve, DELAY_MS); });
    }
  } catch (error) {
    console.error('❌ Failed to run the quiz result notifier:', error.message);
  } finally {
    running = false;
  }
}

module.exports = { sendPendingResults, buildMessage, reviewIsVisible };
