// يتأكد إن كل environment variables الأساسية موجودة قبل ما السيرفر يشتغل
require('dotenv').config();

const required = ['DATABASE_URL', 'SESSION_SECRET', 'ENCRYPTION_KEY'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`❌ Missing environment variables in .env: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and provide the required values.');
  process.exit(1);
}

if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('❌ ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes).');
  console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  publicUrl: process.env.PUBLIC_URL || '',
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  // مفتاح Claude للرد الآلي. **مش في قايمة required عن قصد**: من غيره الرد الآلي بيتعطّل
  // لوحده والباقي بيشتغل عادي — مايستاهلش يمنع السيرفر من الإقلاع
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  // Groq — نماذج مفتوحة بطبقة مجانية. زي مفتاح Claude: غيابه بيعطّل المزوّد ده بس
  groqApiKey: process.env.GROQ_API_KEY || '',
};
