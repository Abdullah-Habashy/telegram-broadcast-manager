const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const pool = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('../utils/crypto');
const registerAdminReportHandler = require('./handlers/adminReport');
const registerStartHandler = require('./handlers/start');
const registerForwardingHandler = require('./handlers/forwarding');
const registerStaffLinkHandler = require('./handlers/staffLink');
const registerMessageHandler = require('./handlers/message');
const registerStudentReportHandler = require('./handlers/studentReport');
const registerStudentTransferHandler = require('./handlers/studentTransfer');
const registerPhoneLinkHandler = require('./handlers/phoneLink');

const WEBHOOK_PATH = '/bot/webhook';

let botInstance = null;
let activeToken = null;
let botUsername = null;

// نستخدم هاش ثابت مبني على SESSION_SECRET كـ secret_token بتاع الـ webhook
// (تليجرام بيرجّعه في هيدر X-Telegram-Bot-Api-Secret-Token مع كل تحديث، وبنتحقق منه قبل المعالجة)
function getSecretToken() {
  return crypto.createHash('sha256').update(env.sessionSecret).digest('hex');
}

async function getStoredToken() {
  const result = await pool.query("SELECT value FROM settings WHERE key = 'bot_token_encrypted'");
  const encrypted = result.rows[0]?.value;
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch (err) {
    console.error('❌ Failed to decrypt the stored bot token:', err.message);
    return null;
  }
}

function createBot(token) {
  const bot = new Telegraf(token);
  // **أول واحد عن قصد.** رسايل حساب الأدمن (اللي بتتحوّل له رسايل البوت) مش رسايل طلاب — لو
  // عدّت على `start.js` أو `message.js` كانت هتفتح تذكرة باسمه وتتوزّع على موظف
  registerAdminReportHandler(bot);
  registerStartHandler(bot);
  registerForwardingHandler(bot);
  registerStaffLinkHandler(bot);
  // **قبل message.js عن قصد.** لو بعده، كل ضغطة على زرار التقرير كانت هتتسجّل كرسالة واردة
  // وتولّع التذكرة أزرق عند الموظف. الهاندلر بيوقفها عنده إلا لما تحتاج بني آدم فعلًا
  registerStudentReportHandler(bot);
  registerStudentTransferHandler(bot);
  // **قبل message.js:** جهة الاتصال المشارَكة نوع رسالة، ولو وصلت للمعالج العادي هتتسجّل
  // كوسائط مش مدعومة والطالب ياخد رد "ابعت مكتوب" على حاجة إحنا اللي طلبناها منه
  registerPhoneLinkHandler(bot);
  registerMessageHandler(bot);
  bot.catch((err, ctx) => {
    console.error(`❌ Telegraf failed while processing update [${ctx.updateType}]:`, err.message);
  });
  return bot;
}

async function verifyToken(token) {
  const candidate = new Telegraf(token);
  return candidate.telegram.getMe();
}

// يجهز البوت الجديد أولًا، ولا يفصل القديم إلا بعد نجاح التحقق وتسجيل Webhook الجديد.
async function activateToken(token) {
  if (botInstance && activeToken === token) return botInstance;

  const bot = createBot(token);
  const botInfo = await bot.telegram.getMe();
  botUsername = botInfo.username;

  if (!env.publicUrl) {
    console.warn('⚠️  PUBLIC_URL is not configured in .env. The bot cannot receive updates until it is set and the server is restarted.');
    const previousBot = botInstance;
    botInstance = bot;
    activeToken = token;
    if (previousBot) {
      try { await previousBot.telegram.deleteWebhook(); } catch (_) { /* التوكن القديم قد يكون غير صالح */ }
    }
    return bot;
  }

  const webhookUrl = `${env.publicUrl}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, { secret_token: getSecretToken() });

  // ---------- قايمة أوامر البوت ----------
  // **فاضية مؤقتًا بطلب صاحب المشروع.** ده بيخفي الزرار الأزرق من تيليجرام بس — الأمر
  // `/report` وكلمة "تقريري" **لسه شغالين بالكامل** في handlers/studentReport.js، فأي طالب
  // معاه الأمر بيشتغل معاه عادي.
  //
  // القايمة الفاضية بتتبعت في كل تشغيل مش مرة واحدة، لأن تيليجرام بيحتفظ بآخر قايمة اتسجّلت
  // على السيرفر بتاعه — فمجرد إن الكود ما ينداهش مش كفاية يشيلها، لازم تتمسح صراحةً.
  //
  // **للرجوع:** حط بدل [] السطر ده:
  //   [{ command: 'report', description: '📊 تقريري ومستواي' }]
  try {
    await bot.telegram.setMyCommands([]);
  } catch (error) {
    // فشل القايمة مايمنعش البوت يشتغل — الأوامر نفسها شغالة سواء ظهرت في القايمة أو لأ
    console.error('⚠️ Failed to update the bot command menu:', error.message);
  }

  const previousBot = botInstance;
  botInstance = bot;
  activeToken = token;
  if (previousBot) {
    try { await previousBot.telegram.deleteWebhook(); } catch (_) { /* التوكن القديم قد يكون غير صالح */ }
  }
  console.log(`✅ Bot @${botInfo.username} connected through webhook: ${webhookUrl}`);
  return bot;
}

// بيتنادى مرة عند تشغيل السيرفر
async function initBot() {
  const token = await getStoredToken();
  if (!token) {
    console.log('ℹ️  No bot token is configured yet. Add one in Settings after signing in.');
    return null;
  }

  try {
    return await activateToken(token);
  } catch (err) {
    console.error('❌ Webhook registration failed. Verify the bot token and ensure PUBLIC_URL uses HTTPS:', err.message);
    return null;
  }
}

function getBot() {
  return botInstance;
}

function getBotUsername() {
  return botUsername;
}

module.exports = { initBot, activateToken, verifyToken, getBot, getBotUsername, getSecretToken, WEBHOOK_PATH };
