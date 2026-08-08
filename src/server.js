const env = require('./config/env'); // لازم يتحمّل الأول عشان يتحقق من متغيرات البيئة
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const path = require('path');

const pool = require('./config/db');
const botManager = require('./bot/botManager');
const { startScheduler } = require('./jobs/scheduler');
const { requireAuth } = require('./middleware/requireAuth');

const authRoutes = require('./routes/auth.routes');
const contactsRoutes = require('./routes/contacts.routes');
const tagsRoutes = require('./routes/tags.routes');
const templatesRoutes = require('./routes/templates.routes');
const broadcastRoutes = require('./routes/broadcast.routes');
const settingsRoutes = require('./routes/settings.routes');
const statsRoutes = require('./routes/stats.routes');
const ticketsRoutes = require('./routes/tickets.routes');
const adminRoutes = require('./routes/admin.routes');
const tafraRoutes = require('./routes/tafra.routes');

const PgSession = pgSessionFactory(session);
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

// ===== صفحات المصادقة =====
app.use('/', authRoutes);

// ===== الصفحة الرئيسية (لوحة التحكم) =====
app.get('/', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT name, role, is_active FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user?.is_active) return req.session.destroy(() => res.redirect('/login'));
  req.session.userName = user.name;
  req.session.userRole = user.role;
  res.render('dashboard', { userName: user.name, userRole: user.role });
});

// ===== واجهات الـ API =====
app.use('/api/contacts', contactsRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/broadcasts', broadcastRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tafra', tafraRoutes);

app.use((req, res) => res.status(404).send('الصفحة مش موجودة'));

// Express 5 بيلقط أخطاء الـ async handlers تلقائيًا ويحولها هنا
app.use((err, req, res, next) => {
  console.error('❌ Unexpected server error:', err);
  res.status(500).json({ error: 'حصل خطأ في السيرفر' });
});

async function start() {
  await botManager.initBot();
  startScheduler();
  app.listen(env.port, () => {
    console.log(`🚀 Server running at http://localhost:${env.port}`);
  });
}

start();
