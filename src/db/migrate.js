// يشغّل ملف schema.sql على قاعدة البيانات المحددة في DATABASE_URL
// تشغيل: npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is missing from .env. See .env.example.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  console.log('⏳ Applying schema.sql to the database...');
  try {
    await pool.query(schemaSql);
    console.log('✅ Database tables created/updated successfully.');
  } catch (err) {
    console.error('❌ Database migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
