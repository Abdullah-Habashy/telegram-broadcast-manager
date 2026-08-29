const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  // بعض مزودي الاستضافة (Render, Railway...) بيطلبوا SSL في الإنتاج
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  // **الافتراضي في pg هو ١٠ اتصالات بس.** طول ما الشغل تذاكر ومزامنة، ده كان كفاية —
  // امتحان بآلاف الطلاب بيخلي كل استعلام يقف في طابور خلف عشرة قبله، والصفحة تبان بطيئة
  // من غير أي خطأ في اللوج. Postgres على السيرفر مظبوط على 100، وسايبين هامش للنسخ
  // الاحتياطي وjobs الكرون وأي جلسة psql للتشخيص
  max: Number(process.env.PG_POOL_MAX) || 40,
  // الاتصال اللي قعد ساكت نص دقيقة بيترجع للحوض — بعد الامتحان الحوض بيرجع لحجمه لوحده
  idleTimeoutMillis: 30_000,
  // بدل ما الطلب يستنى للأبد لو الحوض اتملى: بيفشل بسرعة ويبان في اللوج
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database connection error:', err.message);
});

module.exports = pool;
