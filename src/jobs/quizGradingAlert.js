const cron = require('node-cron');
const pool = require('../config/db');
const botManager = require('../bot/botManager');
const push = require('../utils/push');

// ---------- تنبيه على فشل التصحيح الآلي ----------
//
// **ليه الوظيفة دي موجودة:** يوم ١٢ سبتمبر ٢٠٢٦ خلص رصيد Anthropic، والتصحيح المقالي
// وقف. الأوراق بتتسجّل `partial` مع `grading_error`، والكرون **مابيعيدش المحاولة عليها
// عن قصد** (لو أعاد، ورقة عندها مشكلة دائمة كانت هتفشل كل دقيقة للأبد) — فالورقة بتقعد
// مستنية بني آدم. والمشكلة إن مفيش حاجة بتقول لبني آدم إنها مستنياه.
//
// النتيجة: **٢٣١ ورقة قعدت تلات أيام بدرجة ناقصة ومحدش عرف.** ٣١٣٧ إجابة مقالية
// مصحّحتش، ومتوسط اللي الطالب خسره ٩ درجات من ٤٥. اتكشفت بالغلط وإحنا بنعمل حاجة تانية.
//
// **التنبيه ده هو المخرج الوحيد من الصمت ده** — مش بيصلّح حاجة، بيقول بس إن فيه حاجة
// محتاجة قرار.

// الفشل اللي عمره دقايق ممكن يكون عارض (429 من المزوّد وقت ضغط). ربع ساعة كفاية إنه
// مش عارض — والكرون مش هيعيد المحاولة لوحده فمفيش داعي نستنى أكتر
const ALERT_AFTER_MINUTES = 15;

// **مانكررش التنبيه كل ساعة على نفس المشكلة.** عطل الرصيد قعد ٣ أيام — ٧٢ رسالة كانت
// هتخلي الأدمن يسكّت التنبيه نفسه، وساعتها العطل الجاي يقعد صامت زي الأول
const REALERT_AFTER_HOURS = 6;

// آخر مرة اتبعت فيها تنبيه. في `settings` مش في عمود جديد: الحالة دي بتاعة النظام كله
// مش بتاعة ورقة بعينها، ولو كانت عمود على `quiz_attempts` كان كل ورقة هتنبّه لوحدها
const ALERT_KEY = 'quiz_grading_alert_at';

// أكتر عدد أسماء في الرسالة — الباقي بيتلخّص
const NAMES_IN_MESSAGE = 3;

let running = false;

// **`grading_error IS NOT NULL` هو الفرق كله.** `partial` ليها معنيين: تصحيح آلي فشل،
// أو سؤال النموذج سابه لموظف يراجعه. التانية شغل عادي ومش عطل — والتنبيه للأولى بس،
// وإلا بيتحوّل لضجيج دائم على حاجة طبيعية
const FAILED_ATTEMPTS_SQL = `
  SELECT a.id, a.grading_error, a.submitted_at, q.title AS quiz_title,
    COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(a.student_name), ''), 'طالب') AS student_name,
    ROUND(EXTRACT(EPOCH FROM (NOW() - a.submitted_at)) / 3600)::int AS hours_waiting
  FROM quiz_attempts a
  JOIN quizzes q ON q.id = a.quiz_id
  LEFT JOIN tafra_students s ON s.tafra_student_id = a.tafra_student_id
  WHERE a.grading_status = 'partial'
    AND a.grading_error IS NOT NULL
    AND a.submitted_at IS NOT NULL
    AND a.submitted_at < NOW() - ($1 * INTERVAL '1 minute')
  ORDER BY a.submitted_at
`;

// نفس دالة unansweredAlert.js — العدد في العربي بيغيّر صيغة المعدود، ومن غير ده بتطلع
// رسايل زي "2 ورقة" و"39 أوراق"
function arabicCount(count, { one, two, few, many }) {
  if (count === 1) return one;
  if (count === 2) return two;
  if (count <= 10) return `${count} ${few}`;
  return `${count} ${many}`;
}

function waitedFor(hours) {
  if (hours < 1) return 'أقل من ساعة';
  if (hours < 48) return arabicCount(hours, { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' });
  return arabicCount(Math.floor(hours / 24), { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يوم' });
}

// رسالة المزوّد إنجليزية وطويلة وفيها JSON. الأدمن محتاج يعرف **نوع** المشكلة مش نصها
// الخام — والترجمة دي هي الفرق بين "أعمل إيه" و"مش فاهم حاجة"
function explainError(raw) {
  const text = String(raw || '');
  if (/credit balance is too low/i.test(text)) {
    return { label: 'رصيد المزوّد خلص', action: 'اشحن رصيد Anthropic، وبعدها اعمل إعادة تصحيح للأوراق دي.' };
  }
  if (/rate limit|429/i.test(text)) {
    return { label: 'حد المعدل عند المزوّد', action: 'قلّل `quiz_grading_concurrency` من الإعدادات وأعد التصحيح.' };
  }
  if (/authentication|invalid x-api-key|401/i.test(text)) {
    return { label: 'مفتاح المزوّد مرفوض', action: 'اتأكد من `ANTHROPIC_API_KEY` على السيرفر.' };
  }
  if (/overloaded|529|503/i.test(text)) {
    return { label: 'المزوّد مزنوق مؤقتًا', action: 'استنى شوية وأعد التصحيح.' };
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(text)) {
    return { label: 'الشبكة قطعت مع المزوّد', action: 'أعد التصحيح — لو اتكرر كلّم مزوّد السيرفر.' };
  }
  if (/حكم غير مفهوم|مانداش بالأداة/.test(text)) {
    return { label: 'النموذج رجّع حكم غير مفهوم', action: 'راجع الأوراق دي بإيدك — المشكلة في السؤال أو في المرجع مش في المزوّد.' };
  }
  // مش معروف: بنعرض أول سطر من النص الخام بدل ما نسكت
  return { label: text.replace(/\s+/g, ' ').slice(0, 90) || 'خطأ مش معروف', action: 'افتح ورقة منهم وشوف رسالة الخطأ كاملة.' };
}

function buildMessage(attempts) {
  // أكتر خطأ متكرر هو اللي بيوصف العطل — أعطال متفرقة معناها أسباب متفرقة
  const counts = new Map();
  attempts.forEach((a) => {
    const { label } = explainError(a.grading_error);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topLabel, topCount] = ranked[0];
  const { action } = explainError(attempts.find((a) => explainError(a.grading_error).label === topLabel).grading_error);

  const oldest = attempts[0];
  // الصفة جوه المعدود مش بره: "ورقتين مستنية" غلط و"ورقتين مستنيين" صح، والمطابقة
  // في العربي بتتغيّر مع العدد فمش بينفع تتكتب مرة واحدة برّه
  const headline = arabicCount(attempts.length, {
    one: 'ورقة مستنية', two: 'ورقتين مستنيين', few: 'أوراق مستنية', many: 'ورقة مستنية',
  });

  const lines = [
    '🛑 التصحيح الآلي فاشل',
    '',
    `فيه ${headline}، أقدمها من ${waitedFor(oldest.hours_waiting)}.`,
    '',
    `السبب الأغلب: ${topLabel} (${topCount} من ${attempts.length})`,
    `اعمل إيه: ${action}`,
  ];

  // أسباب تانية موجودة؟ بتتكتب عشان الأدمن مايصلّح واحد ويفتكر إنه خلص
  if (ranked.length > 1) {
    lines.push('', 'أسباب تانية:');
    ranked.slice(1, 4).forEach(([label, count]) => lines.push(`• ${label} — ${count}`));
  }

  lines.push('', 'أمثلة:');
  attempts.slice(0, NAMES_IN_MESSAGE).forEach((a) => {
    lines.push(`• ${a.student_name} — ${a.quiz_title}`);
  });
  const rest = attempts.length - Math.min(NAMES_IN_MESSAGE, attempts.length);
  if (rest > 0) lines.push(`• و${rest} غيرهم`);

  return lines.join('\n');
}

// **بيروح لـ`forward_chat_id` قبل أي حد تاني.** حساب الأدمن في `users` مش مربوط
// بتيليجرام (موثّق في WORKLOG)، فالإرسال للأدمنز لوحدهم معناه إن التنبيه مايوصلش حد —
// وده بالظبط العطل اللي الوظيفة دي موجودة عشانه
async function recipients() {
  const [{ rows: settingRows }, { rows: adminRows }] = await Promise.all([
    pool.query("SELECT value FROM settings WHERE key = 'forward_chat_id'"),
    pool.query("SELECT id, telegram_chat_id FROM users WHERE is_active = TRUE AND role = 'admin'"),
  ]);
  const chatIds = new Set();
  const botAdmin = settingRows[0]?.value;
  if (botAdmin) chatIds.add(String(botAdmin));
  adminRows.forEach((row) => { if (row.telegram_chat_id) chatIds.add(String(row.telegram_chat_id)); });
  return { chatIds: [...chatIds], userIds: adminRows.map((row) => row.id) };
}

async function sendQuizGradingAlerts() {
  if (running) return;
  running = true;
  try {
    // **مفيش شرط مواعيد عمل هنا، عكس تنبيه التذاكر.** ده عطل في النظام مش تذكرة مستنية
    // رد — وكل ساعة بيعدي عليه معناها أوراق أكتر بدرجة ناقصة
    const { rows: attempts } = await pool.query(FAILED_ATTEMPTS_SQL, [ALERT_AFTER_MINUTES]);
    if (!attempts.length) return;

    const { rows: lastAlert } = await pool.query(
      'SELECT value FROM settings WHERE key = $1', [ALERT_KEY]);
    const last = lastAlert[0]?.value ? new Date(lastAlert[0].value) : null;
    if (last && Number.isFinite(last.getTime())
      && Date.now() - last.getTime() < REALERT_AFTER_HOURS * 3600 * 1000) {
      return;
    }

    const message = buildMessage(attempts);
    const { chatIds, userIds } = await recipients();
    const bot = botManager.getBot();

    const results = await Promise.allSettled([
      ...chatIds.map((chatId) => (bot
        ? bot.telegram.sendMessage(chatId, message)
        : Promise.reject(new Error('البوت غير متصل')))),
      // إشعار المتصفح كمان: الأدمن ممكن يكون على اللوحة ومش فاتح تيليجرام
      userIds.length
        ? push.sendToUsers(userIds, {
          title: 'التصحيح الآلي فاشل',
          body: `${attempts.length} ورقة مستنية مراجعة`,
          tag: 'quiz-grading-failure',
          url: '/?tab=quizzes',
        })
        : Promise.resolve(),
    ]);

    const failed = results.filter((r) => r.status === 'rejected');
    failed.forEach((r) => console.error('❌ Failed to deliver the quiz-grading alert:', r.reason?.message));

    // **الوسم بيتم بس لو وصل لحد واحد على الأقل.** لو الإرسال كله فشل، التشغيلة الجاية
    // بتحاول تاني — الوسم كان هيسكّت التنبيه على عطل حقيقي لمدة ٦ ساعات من غير ما حد ياخد باله
    if (failed.length < results.length) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, NOW()::text)
         ON CONFLICT (key) DO UPDATE SET value = NOW()::text`, [ALERT_KEY]);
      console.log(`🛑 Alerted about ${attempts.length} quiz attempt(s) whose automatic grading failed.`);
    }
  } finally {
    running = false;
  }
}

function startQuizGradingAlert() {
  // كل ساعة: الـREALERT_AFTER_HOURS هو اللي بيحكم التكرار فعليًا، والدورة كل ساعة
  // بتخلي أول تنبيه على عطل جديد يوصل بسرعة
  cron.schedule('0 * * * *', () => {
    sendQuizGradingAlerts().catch((err) =>
      console.error('❌ Failed to run the quiz-grading alert:', err.message)
    );
  });
  console.log('✅ Quiz-grading failure alert started; checking every hour.');
}

module.exports = { startQuizGradingAlert, sendQuizGradingAlerts };
