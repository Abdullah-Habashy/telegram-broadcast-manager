// إدارة "بوت طفرة" — بوت تليجرام مستقل تمامًا وشغّال بالتوازي مع بوت المتابعة، بحد أدنى
// من الوظايف دلوقتي: تسجيل أي حد يضغط /start بس، عشان نعرف مين من طلاب المنصة بدأه ومين لسه.
// نفس نمط src/bot/botManager.js لكن بمسار Webhook ومفتاح سري منفصلين تمامًا عن البوت الأساسي.
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const pool = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('../utils/crypto');

const WEBHOOK_PATH = '/bot2/webhook';

// بوت طفرة هو نفس بوت منصة طفرة الرسمي، وتيليجرام بيسمح بويب هوك واحد بس شغال في نفس الوقت —
// فلو المنصة سجّلت الويب هوك بتاعها هي على نفس البوت، بنفقد استقبال التحديثات من غير أي خطأ ظاهر
// عندنا. القيم دي هي اللي لاحظناها فعليًا عن طريق getWebhookInfo وقت اكتشاف المشكلة —
// لو المنصة غيّرت الرابط بتاعها يومًا ما، الزرار ده محتاج تحديث كمان
const TAFRA_WEBHOOK_URL = 'https://api.abdullah-habashy.com/v1/academy/telegram/webhook';
const TAFRA_ALLOWED_UPDATES = ['message', 'callback_query'];

let botInstance = null;
let activeToken = null;
let botUsername = null;

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

// الافتراضي دايمًا عند أي تشغيل جديد للسيرفر (Restart) إننا "نسيب" الويب هوك لمنصة طفرة — مش
// إحنا اللي بنطلبه تلقائيًا لنفسنا. الرجوع لينا قرار يدوي بس، عن طريق زرار "رجّع لينا" في الداشبورد،
// وإلا كل Restart (وده بيحصل كتير مع أي نشر تحديث) كان هيقاطع ميزات منصة طفرة نفسها من غير قصد
async function activateToken(token) {
  if (botInstance && activeToken === token) return botInstance;

  const bot = createBot(token);
  const botInfo = await bot.telegram.getMe();
  botUsername = botInfo.username;
  botInstance = bot;
  activeToken = token;

  try {
    await bot.telegram.setWebhook(TAFRA_WEBHOOK_URL, { allowed_updates: TAFRA_ALLOWED_UPDATES });
    console.log(`✅ New bot @${botInfo.username} ready — webhook left with Tafra's platform by default.`);
  } catch (err) {
    console.error('❌ فشل تسجيل الويب هوك الافتراضي لمنصة طفرة عند التشغيل:', err.message);
  }
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
    console.error('❌ فشل تسجيل Webhook بوت طفرة:', err.message);
    return null;
  }
}

function getBot() {
  return botInstance;
}

function getBotUsername() {
  return botUsername;
}

// نفس البوت المحفوظ في الذاكرة (لو موجود) أو instance جديد بالتوكن المحفوظ — مستخدم لعمليات
// الويب هوك (قراءة/تبديل)، من غير ما نلمس الحالة المحفوظة (activeToken) إلا وقت التفعيل الفعلي
async function getBotForWebhookOps() {
  if (botInstance) return botInstance;
  const token = await getStoredToken();
  if (!token) return null;
  return new Telegraf(token);
}

// قراءة بس — بتوضح مين حاليًا صاحب الويب هوك (إحنا، منصة طفرة، أو حاجة تالتة)
async function getWebhookStatus() {
  const bot = await getBotForWebhookOps();
  if (!bot) return null;
  const info = await bot.telegram.getWebhookInfo();
  const ourUrl = env.publicUrl ? `${env.publicUrl}${WEBHOOK_PATH}` : null;
  const pointingTo = !info.url ? 'none' : info.url === ourUrl ? 'us' : info.url === TAFRA_WEBHOOK_URL ? 'tafra' : 'other';
  return { ...info, pointing_to: pointingTo };
}

// تسجيل الويب هوك على سيرفرنا بالقوة، حتى لو activateToken فاكر إنه أصلاً مسجّل (ده بالظبط سبب
// الحاجة للزرار ده — تيليجرام ممكن يتغيّر من برّه من غير ما نعرف)
async function claimWebhookForUs() {
  if (!env.publicUrl) throw new Error('PUBLIC_URL غير محدد في الإعدادات');
  const bot = await getBotForWebhookOps();
  if (!bot) throw new Error('لسه معملتش ربط للبوت الجديد');
  const webhookUrl = `${env.publicUrl}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, { secret_token: getSecretToken() });
  botInstance = bot;
  activeToken = await getStoredToken();
  return webhookUrl;
}

// إرجاع الويب هوك لمنصة طفرة — مفيد لو محتاجين ميزات المنصة نفسها (زي ربط الحساب) تشتغل تاني
async function releaseWebhookToTafra() {
  const bot = await getBotForWebhookOps();
  if (!bot) throw new Error('لسه معملتش ربط للبوت الجديد');
  await bot.telegram.setWebhook(TAFRA_WEBHOOK_URL, { allowed_updates: TAFRA_ALLOWED_UPDATES });
  return TAFRA_WEBHOOK_URL;
}

module.exports = {
  initBot, getBot, getBotUsername, getSecretToken, WEBHOOK_PATH,
  getWebhookStatus, claimWebhookForUs, releaseWebhookToTafra,
};
