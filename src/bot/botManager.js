const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const pool = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('../utils/crypto');
const registerStartHandler = require('./handlers/start');
const registerForwardingHandler = require('./handlers/forwarding');
const registerMessageHandler = require('./handlers/message');

const WEBHOOK_PATH = '/bot/webhook';

let botInstance = null;
let activeToken = null;

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
  registerStartHandler(bot);
  registerForwardingHandler(bot);
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

module.exports = { initBot, activateToken, verifyToken, getBot, getSecretToken, WEBHOOK_PATH };
