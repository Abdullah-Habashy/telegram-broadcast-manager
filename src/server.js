const env = require('./config/env'); // لازم يتحمّل الأول عشان يتحقق من متغيرات البيئة
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const path = require('path');

const pool = require('./config/db');
const botManager = require('./bot/botManager');
const newBotManager = require('./bot/newBotManager');
const whatsapp = require('./integrations/whatsapp');
const { startSilentFollowUp } = require('./jobs/silentFollowUp');
const { startScheduler } = require('./jobs/scheduler');
const { startTafraSyncScheduler } = require('./jobs/tafraSyncScheduler');
const { startStaffActivityDigest } = require('./jobs/staffActivityDigest');
const { startWelcomeMessageSender } = require('./jobs/welcomeMessageSender');
const { startCallAutoAssign } = require('./jobs/callAutoAssign');
const { startUnansweredAlert } = require('./jobs/unansweredAlert');
const { startTeamAutoReturn } = require('./jobs/teamAutoReturn');
const { startWhatsappRouting } = require('./jobs/whatsappRouting');
const { startQuizFinalizer } = require('./jobs/quizFinalizer');
const { startQuizGradingAlert } = require('./jobs/quizGradingAlert');
const { requireAuth, requireAdminPage } = require('./middleware/requireAuth');

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
const { canManageQuizzes: teamCanManageQuizzes } = require('./utils/teams');
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

// **التوقيع بيتحسب على البايتات الخام.** `express.json()` بيفك الجسم ويرمي الأصل،
// وإعادة بنائه بـ`JSON.stringify` بتغيّر المسافات وترتيب المفاتيح فالتوقيع يفشل على
// طلبات سليمة. الحفظ متقصور على مسار واتساب عشان مانضاعفش ذاكرة كل طلب في النظام
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/whatsapp/')) req.rawBody = buf;
  },
}));
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

// ===== WhatsApp Webhook (Meta Cloud API) =====
//
// **فيسبوك بيستخدم نفس المسار لحاجتين مختلفتين:** GET مرة واحدة وقت التسجيل للتأكد إن
// السيرفر بتاعنا، وPOST لكل رسالة بعد كده.
app.get(whatsapp.WEBHOOK_PATH, async (req, res) => {
  try {
    const { verifyToken } = await whatsapp.getConfig();
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      console.log('✅ WhatsApp webhook verified by Meta.');
      // الرد لازم يكون النص الخام بالظبط — أي تغليف بيفشّل التحقق
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    console.error('⚠️ WhatsApp webhook verification refused: the token did not match.');
    return res.sendStatus(403);
  } catch (error) {
    console.error('❌ WhatsApp webhook verification failed:', error.message);
    return res.sendStatus(500);
  }
});

// **الرد بـ٢٠٠ الأول، والمعالجة بعدها.** فيسبوك بيعيد إرسال أي طلب مابيردّش بسرعة،
// والإعادة معناها رسالة مكررة عند الطالب — فالتسجيل بيحصل بعد ما نقفل الرد
app.post(whatsapp.WEBHOOK_PATH, async (req, res) => {
  let config;
  try {
    config = await whatsapp.getConfig();
  } catch (error) {
    console.error('❌ Failed to read the WhatsApp config:', error.message);
    return res.sendStatus(500);
  }

  const check = whatsapp.verifySignature(req.rawBody, req.headers['x-hub-signature-256'], config.appSecret);
  if (!check.ok) {
    // **الرفض مقصود مش تساهل.** من غير التحقق أي حد يعرف الرابط يقدر يزوّر رسالة طالب
    console.error(`⚠️ A WhatsApp webhook call was refused: ${check.reason}`);
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const payload = req.body || {};
    const messages = whatsapp.extractMessages(payload);
    const statuses = whatsapp.extractStatuses(payload);
    await whatsapp.storeEvent({ payload, messages, statuses });
    if (messages.length) {
      console.log(`💬 WhatsApp: ${messages.length} incoming message(s) stored, ${statuses.length} status update(s).`);
    }
  } catch (error) {
    console.error('❌ Failed to store a WhatsApp webhook payload:', error.message);
  }
});

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
// الصفحة بتسأل بيه عن الدرجة بعد التسليم — التصحيح بقى في طابور مش في نفس الطلب
app.get('/q/:ref/result', quizPublicController.getResult);
// تظلّم الطالب على درجة سؤال — عام زي باقي مسارات `/q/`، ومحمي بـattempt_key
app.post('/q/:ref/appeal', quizPublicController.submitAppeal);
// رفع صورة الإجابة المقالية وشيلها. **نفس حماية الحفظ:** attempt_key + الورقة لسه مفتوحة
app.post('/q/:ref/answer-image', quizPublicController.answerImageUpload.single('image'),
  quizPublicController.uploadAnswerImage);
app.post('/q/:ref/answer-image/remove', quizPublicController.removeAnswerImageRow);

// معاينة ورقة الطالب بعين الطالب — للأدمن بس. **على مسار منفصل عن `/q/` عن قصد:**
// `/q/` كله عام بدون مصادقة، وإضافة مسار محمي جواه كانت هتخلي القاعدة دي مش واضحة
// لأي حد يقرا الملف بعدين
app.get('/quiz-preview/:attemptId', requireAdminPage, quizPublicController.renderStudentPreview);

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
  // بناء الاختبارات: الأدمن + التيمات اللي عليها canManageQuizzes في utils/teams.js.
  // بنقرا user.team مش userTeam لأن ده بيتصفّر للأدمن فوق
  const canManageQuizzes = user.role === 'admin' || teamCanManageQuizzes(user.team);
  req.session.canManageQuizzes = canManageQuizzes;
  const defaultTab = user.role === 'admin' ? 'overview' : canViewTickets ? 'tickets' : canViewCalls ? 'calls' : null;
  res.render('dashboard', {
    userName: user.name, userRole: user.role, userId: req.session.userId,
    canViewTickets, canViewCalls, canAssignCalls, canManageQuizzes, userTeam, defaultTab,
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
  // فحص الوصول لبوت طفرة كان ناقص من هنا، وده وقّعه فعليًا: الفحص مات وسط شغله في
  // ١٧ أغسطس، والسطر فضل 'running' شهر كامل. الزرار في اللوحة بيتقفل على الحالة دي
  // (`button.disabled = sync.status === 'running'`)، فصاحب المشروع ماكانش يقدر يعيده
  // خالص — واتراكم ٣٧١٣ طالب مربوط ماتفحصوش ولا مرة
  await pool.query(
    `UPDATE new_bot_reachability_sync_status SET status='failed', error_message=$1, completed_at=NOW(), updated_at=NOW()
     WHERE id=1 AND status='running'`,
    [staleMessage]
  );
  // والمزامنة الانتقائية كمان — نفس النمط، ومحصلتش لحد دلوقتي بس مافيش سبب تستنى لما تحصل
  await pool.query(
    `UPDATE tafra_selective_sync_status SET status='failed', error_message=$1, completed_at=NOW(), updated_at=NOW()
     WHERE id=1 AND status='running'`,
    [staleMessage]
  );
}

async function start() {
  await resetStaleSyncStatuses();

  // نص التحقق بتاع واتساب لازم يكون موجود **قبل** ما حد يفتح لوحة فيسبوك ويسجّل الويبهوك،
  // فبيتولّد هنا مرة واحدة ويفضل زي ما هو
  await whatsapp.ensureVerifyToken().catch((error) =>
    console.error('❌ Failed to prepare the WhatsApp verify token:', error.message));

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

    // ---------- دور العملية دي ----------
    //
    // **عملية واحدة بتعمل كل حاجة، وده سقف حقيقي مش تفصيلة.** الويب والبوت والجدولة
    // كلهم على نفس النواة، فامتحان بآلاف الطلاب بيزاحم المتابعات التلقائية والمزامنة
    // على نفس العملية. والتوسّع بنسخ متعددة كان مستحيل: نسختين معناهم جدولة مكررة —
    // إرسال جماعي مرتين ومتابعات مرتين — وعشان كده السيرفر بيموت عمدًا على EADDRINUSE.
    //
    // APP_ROLE بيفك التعارض ده: `web` بيخدم الطلبات بس وينفع يتنسخ ورا موزّع أحمال،
    // و`jobs` بيشغّل الجدولة والبوت **في نسخة واحدة بالظبط**. الافتراضي `all` — نفس
    // السلوك الحالي بالحرف، فمافيش أي تغيير على النشر القايم.
    //
    // ⚠️ **الويبهوك في نسخة الـjobs.** البوت بيسجّل webhook واحد عند تيليجرام، ولو
    // اتنقلنا لنسختين لازم الموزّع يوجّه /bot/webhook للنسخة اللي شغّالة jobs — أو
    // نسيب الدور all زي ما هو
    const role = process.env.APP_ROLE || 'all';
    const runsJobs = role === 'all' || role === 'jobs';

    if (!runsJobs) {
      console.log(`🌐 APP_ROLE=${role} — الطلبات بس: مفيش بوت ومفيش جدولة في العملية دي.`);
      return;
    }
    if (role !== 'all') {
      console.log(`⚙️  APP_ROLE=${role} — البوت والجدولة شغّالين هنا. **نسخة واحدة بس** من الدور ده.`);
    }

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
    startSilentFollowUp();
    startQuizFinalizer();
    startQuizGradingAlert();
  });
}

start();
