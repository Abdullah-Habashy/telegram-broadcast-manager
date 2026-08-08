const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  // بعض مزودي الاستضافة (Render, Railway...) بيطلبوا SSL في الإنتاج
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database connection error:', err.message);
});

module.exports = pool;
