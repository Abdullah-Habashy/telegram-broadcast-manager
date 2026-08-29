const env = require('./config/env'); // لازم يتحمّل الأول عشان يتحقق من متغيرات البيئة
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const path = require('path');

const pool = require('./config/db');
const botManager = require('./bot/botManager');
const newBotManager = require('./bot/newBotManager');
const { startScheduler } = require('./jobs/scheduler');
const { startTafraSyncScheduler } = require('./jobs/tafraSyncScheduler');
const { startStaffActivityDigest } = require('./jobs/staffActivityDigest');
const { startWelcomeMessageSender } = require('./jobs/welcomeMessageSender');
const { startCallAutoAssign } = require('./jobs/callAutoAssign');
const { startUnansweredAlert } = require('./jobs/unansweredAlert');
const { startTeamAutoReturn } = require('./jobs/teamAutoReturn');
const { startWhatsappRouting } = require('./jobs/whatsappRouting');
const { startQuizFinalizer } = require('./jobs/quizFinalizer');
const { requireAuth } = require('./middleware/requireAuth');

const authRoutes = require('./routes/auth.routes');
const contactsRoutes = require('./routes/contacts.routes');
const tagsRoutes = require('./routes/tags.routes');
const templatesRoutes = require('./routes/templates.routes');
const broadcastRoutes = require('./routes/broadcast.routes');
const settingsRoutes = require('./routes/settings.routes');
const statsRoutes = require('./routes/stats.routes');
const performanceRoutes = require('./routes/performance.routes');
const studentReportRoutes = require('./routes/studentReport.routes');
const studentReportController = require('./controllers/studentReport.controller');
const quizPublicController = require('./controllers/quizPublic.controller');
const ticketsRoutes = require('./routes/tickets.routes');
const assistRoutes = require('./routes/assist.routes');
const adminRoutes = require('./routes/admin.routes');
const tafraRoutes = require('./routes/tafra.routes');
const pushRoutes = require('./routes/push.routes');
const callsRoutes = require('./routes/calls.routes');
const quizzesRoutes = require('./routes/quizzes.routes');
const publicRoutes = require('./routes/public.routes');

const PgSession = pgSessionFactory(session);
const app = express();

// بصمة إصدار بتتحسب مرة واحدة عند التشغيل من أحدث وقت تعديل بين ملفات الواجهة. بتتحط على
// رابط style.css فالمتصفح بيجيب النسخة الجديدة بعد كل نشر بدل ما يفضل على القديمة المخزّنة —
// كانت التعديلات مابتظهرش على التليفون بعد النشر لحد ما المستخدم يعمل hard refresh يدوي
const ASSET_VERSION = (() => {
  const fs = require('fs');
  const files = [
    path.join(__dirname, '..', 'public', 'style.css'),
    path.join(__dirname, 'views', 'dashboard.ejs'),
  ];
  const newest = files.reduce((latest, file) => {
    try { return Math.max(latest, fs.statSync(file).mtimeMs); } catch (_) { return latest; }
  }, 0);
  return String(Math.floor(newest));
})();
app.locals.assetVersion = ASSET_VERSION;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// السيرفر بيشتغل ورا Cloudflare Tunnel (HTTPS بيتفكّ عند Cloudflare والاتصال الداخلي للسيرفر HTTP عادي)،
// فلازم Express يثق في هيدر X-Forwarded-Proto عشان يعرف الاتصال فعليًا HTTPS — وإلا كوكي الجلسة
// (secure: true في production) مش هتتبعت للمتصفح خالص، وتسجيل الدخول هيرجع لصفحة اللوجين تاني
// من غير أي رسالة خطأ ظاهرة (بالظبط الأعراض اللي حصلت بعد النقل للسيرفر)
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// صفحات HTML مبنية من السيرفر وفيها الجافاسكريبت جوّه، فأي كاش ليها معناه إن المستخدم يفضل
// شغّال على نسخة قديمة بعد النشر. الملفات الثابتة فوق مش متأثرة — بتتكسّر بـ assetVersion
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});

app.use(
  session({
    store: new PgSession({ pool, tableName: 'session' }),
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // أسبوع
      secure: env.nodeEnv === 'production',
      httpOnly: true,
    },
  })
);

// ===== Telegram Webhook =====
// بيوصله تحديثات البوت مباشرة من تليجرام — بنتحقق من الـ secret token قبل المعالجة
app.post(botManager.WEBHOOK_PATH, (req, res) => {
  const bot = botManager.getBot();
  if (!bot) return res.sendStatus(404);
  if (req.headers['x-telegram-bot-api-secret-token'] !== botManager.getSecretToken()) {
    return res.sendStatus(401);
  }
  bot.handleUpdate(req.body, res);
});
app.post(newBotManager.WEBHOOK_PATH, (req, res) => {
  const bot = newBotManager.getBot();
  if (!bot) return res.sendStatus(404);
  if (req.headers['x-telegram-bot-api-secret-token'] !== newBotManager.getSecretToken()) {
    return res.sendStatus(401);
  }
  bot.handleUpdate(req.body, res);
});

// ===== تقرير الطالب المشترَك =====
// صفحة عامة من غير تسجيل دخول — الحماية الوحيدة إن التوكن عشوائي وطويل. متسجّلة قبل مسارات
// المصادقة عشان مايتمش تحويلها للوجين، وبرّه /api عن قصد: ده رابط بيتبعت لولي الأمر بالإيد
app.get('/r/:token', studentReportController.renderPublicReport);
app.get('/r/:token/videos', studentReportController.getPublicReportVideos);
// نفس التوكن بمسار تاني: /r/ لولي الأمر، /me/ للطالب نفسه. الفرق في العرض مش في الصلاحية
app.get('/me/:token', studentReportController.renderSelfReport);
app.get('/me/:token/videos', studentReportController.getSelfReportVideos);

// ===== صفحة الاختبار للطالب =====
// متسجّلة قبل مسارات المصادقة عشان مايتمش تحويلها للوجين. الـ ref بياخد الرابط المختصر
// (/q/bio-1) أو التوكن الطويل — الاتنين على نفس الاختبار عشان الروابط القديمة ماتكسرش.
// الهوية بتتحدد جوه الصفحة برقم التليفون، والأسئلة بتيجي في نداء منفصل بعد الدخول
app.get('/q/:ref', quizPublicController.renderQuiz);
app.post('/q/:ref/start', quizPublicController.startAttempt);
app.post('/q/:ref/save', quizPublicController.saveProgress);
app.post('/q/:ref/submit', quizPublicController.submitAttempt);

// نفس التقرير للموظف المسجّل دخول بمعرّف الطالب — من غير ما يحتاج يعمل رابط عام
app.get('/student-report/:id', requireAuth, studentReportController.renderStaffReport);
app.get('/student-report/:id/videos', requireAuth, studentReportController.getStaffReportVideos);

// ===== صفحات المصادقة =====
app.use('/', authRoutes);

// ===== الصفحة الرئيسية (لوحة التحكم) =====
app.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT name, role, is_active, can_view_tickets, can_view_calls, can_assign_calls, team FROM users WHERE id = $1',
    [req.session.userId]
  );
  const user = result.rows[0];
  if (!user?.is_active) return req.session.destroy(() => res.redirect('/login'));
  req.session.userName = user.name;
  req.session.userRole = user.role;
  // الأدمن معفى دايمًا من صلاحيات العرض دي — بتخص الموظف (agent) بس
  const canViewTickets = user.role === 'admin' || user.can_view_tickets;
  const canViewCalls = user.role === 'admin' || user.can_view_calls;
  const canAssignCalls = user.role === 'admin' || user.can_assign_calls;
  req.session.canViewTickets = canViewTickets;
  req.session.canViewCalls = canViewCalls;
  req.session.canAssignCalls = canAssignCalls;
  // موظف التيم المتخصص بيشوف المحوّل له بس. الأدمن مستثنى: هو بيشوف كل حاجة أصلًا
  const userTeam = user.role === 'admin' ? null : (user.team || null);
  req.session.userTeam = userTeam;
  const defaultTab = user.role === 'admin' ? 'overview' : canViewTickets ? 'tickets' : canViewCalls ? 'calls' : null;
  res.render('dashboard', {
    userName: user.name, userRole: user.role, userId: req.session.userId,
    canViewTickets, canViewCalls, canAssignCalls, userTeam, defaultTab,
    impersonatorAdminName: req.session.impersonatorAdminId ? req.session.impersonatorAdminName : null,
  });
});

// ===== واجهات الـ API =====
app.use('/api/contacts', contactsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/broadcasts', broadcastRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/student-report', studentReportRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/assist', assistRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tafra', tafraRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/quizzes', quizzesRoutes);
// بدون تسجيل دخول أو مفتاح API — بناءً على طلب صريح من المستخدم، مفتوحة لأي نظام خارجي
app.use('/api/public', publicRoutes);

app.use((req, res) => res.status(404).send('الصفحة مش موجودة'));

// Express 5 بيلقط أخطاء الـ async handlers تلقائيًا ويحولها هنا
app.use((err, req, res, next) => {
  console.error('❌ Unexpected server error:', err);
  res.status(500).json({ error: 'حصل خطأ في السيرفر' });
});

// أعلام المزامنة الجارية بتتصفر في الميموري بس مع كل تشغيل جديد للسيرفر — لو السيرفر اتقفل
// فجأة وقت مزامنة شغّالة (تحديث الطلاب/الاشتراكات/الاختبارات)، سطر حالتها بيفضل عالق على
// "running" للأبد وبيمنع أي محاولة تحديث جديدة. بنصلّح أي حالة عالقة كده أول ما السيرفر يشتغل.
async function resetStaleSyncStatuses() {
  const staleMessage = 'توقفت العملية بسبب إعادة تشغيل السيرفر — جرّب تضغط تحديث تاني';
  await pool.query(
    `UPDATE tafra_sync_status SET status='failed', error_message=$1, completed_at=NOW(), updated_at=NOW()
     WHERE id=1 AND status='running'`,
    [staleMessage]
  );
  await pool.query(
    `UPDATE tafra_enrollment_sync_status SET status='failed', error_message=$1, completed_at=NOW(), updated_at=NOW()
     WHERE id=1 AND status='running'`,
    [staleMessage]
  );
  await pool.query(
    `UPDATE tafra_exam_sync_status SET status='failed', error_message=$1, completed_at=NOW(), updated_at=NOW()
     WHERE id=1 AND status IN ('running', 'discovering')`,
    [staleMessage]
  );
}

async function start() {
  await resetStaleSyncStatuses();

  // مهم: البوت والـ cron jobs (الإرسال الجماعي، المتابعة التلقائية، مزامنة طفرة) ما بيبدأوش غير
  // بعد ما السيرفر ينجح فعليًا في حجز المنفذ. لو المنفذ مشغول من نسخة تانية شغّالة بالفعل (مثلاً
  // نسيت تقفل npm run dev قبل ما تشغّل نسخة تانية يدويًا)، العملية دي بتقفل فورًا بدل ما تفضل
  // شغّالة في الخلفية كنسخة مكررة "شبح" بتعمل نفس الجدولة من غير ما حد يلاحظها — وده اللي بيسبب
  // احتمال إرسال رسائل جماعية أو متابعات مكررة لو فيه أكتر من نسخة شغّالة في نفس الوقت
  const server = app.listen(env.port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `❌ المنفذ ${env.port} مستخدم بالفعل من عملية سيرفر تانية شغّالة. اقفل أي نسخة قديمة ` +
        `(npm run dev أو node src/server.js) الأول قبل ما تشغّل نسخة جديدة.`
      );
    } else {
      console.error('❌ Server failed to start:', err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`🚀 Server running at http://localhost:${env.port}`);
    await botManager.initBot();
    await newBotManager.initBot();
    startScheduler();
    startTafraSyncScheduler();
    startStaffActivityDigest();
    startWelcomeMessageSender();
    startCallAutoAssign();
    startUnansweredAlert();
    startTeamAutoReturn();
    startWhatsappRouting();
    startQuizFinalizer();
  });
}

start();
