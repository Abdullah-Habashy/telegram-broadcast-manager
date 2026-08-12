// إدارة "البوت الجديد" — بوت تليجرام مستقل تمامًا وشغّال بالتوازي مع بوت الدعم الحالي، بحد أدنى
// من الوظايف دلوقتي: تسجيل أي حد يضغط /start بس، عشان نعرف مين من طلاب المنصة بدأه ومين لسه.
// نفس نمط src/bot/botManager.js لكن بمسار Webhook ومفتاح سري منفصلين تمامًا عن البوت الأساسي.
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const pool = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('../utils/crypto');

const WEBHOOK_PATH = '/bot2/webhook';

let botInstance = null;
let activeToken = null;

function getSecretToken() {
  return crypto.createHash('sha256').update(env.sessionSecret + ':new-bot').digest('hex');
}

async function getStoredToken() {
  const result = await pool.query("SELECT value FROM settings WHERE key = 'new_bot_token_encrypted'");
  const encrypted = result.rows[0]?.value;
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch (err) {
    console.error('❌ Failed to decrypt the stored new-bot token:', err.message);
    return null;
  }
}

function createBot(token) {
  const bot = new Telegraf(token);
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const { username, first_name, last_name } = ctx.from;
    try {
      await pool.query(
        `INSERT INTO new_bot_contacts (chat_id, telegram_username, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chat_id) DO UPDATE SET
           telegram_username = EXCLUDED.telegram_username,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name`,
        [chatId, username || null, first_name || null, last_name || null]
      );
      await ctx.reply('أهلاً بيك! ✅ تم تسجيلك بنجاح.');
    } catch (err) {
      console.error('❌ Failed to register a /start on the new bot:', err.message);
    }
  });
  bot.catch((err, ctx) => {
    console.error(`❌ New-bot Telegraf failed while processing update [${ctx.updateType}]:`, err.message);
  });
  return bot;
}

async function activateToken(token) {
  if (botInstance && activeToken === token) return botInstance;

  const bot = createBot(token);
  const botInfo = await bot.telegram.getMe();

  if (!env.publicUrl) {
    console.warn('⚠️  PUBLIC_URL غير محدد — البوت الجديد مش هيستقبل تحديثات لحد ما يتحدد ويتعاد تشغيل السيرفر.');
    botInstance = bot;
    activeToken = token;
    return bot;
  }

  const webhookUrl = `${env.publicUrl}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, { secret_token: getSecretToken() });
  botInstance = bot;
  activeToken = token;
  console.log(`✅ New bot @${botInfo.username} connected through webhook: ${webhookUrl}`);
  return bot;
}

async function initBot() {
  const token = await getStoredToken();
  if (!token) {
    console.log('ℹ️  لسه معملتش ربط للبوت الجديد.');
    return null;
  }
  try {
    return await activateToken(token);
  } catch (err) {
    console.error('❌ فشل تسجيل Webhook البوت الجديد:', err.message);
    return null;
  }
}

function getBot() {
  return botInstance;
}

module.exports = { initBot, getBot, getSecretToken, WEBHOOK_PATH };
