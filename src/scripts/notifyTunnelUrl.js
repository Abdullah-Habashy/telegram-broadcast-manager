const { Telegraf } = require('telegraf');
const pool = require('../config/db');
const env = require('../config/env');
const { decrypt } = require('../utils/crypto');

async function main() {
  const publicUrl = String(process.argv[2] || env.publicUrl || '').trim().replace(/\/$/, '');

  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(publicUrl)) {
    throw new Error('A valid trycloudflare.com URL is required.');
  }

  // كل موظف ربط حسابه الشخصي على تيليجرام (عن طريق /linkstaff) بيوصله الرابط تلقائيًا — ده المصدر
  // الأساسي دلوقتي، وبنضيفله كمان أي أرقام قديمة متحطة يدويًا في .env عشان ما حدش يفوته أثناء
  // فترة الانتقال قبل ما كل الموظفين يربطوا حساباتهم
  const staffResult = await pool.query(
    "SELECT telegram_chat_id FROM users WHERE is_active = TRUE AND telegram_chat_id IS NOT NULL"
  );
  const staffChatIds = staffResult.rows.map((row) => String(row.telegram_chat_id));

  const envChatIds = String(process.env.TUNNEL_NOTIFY_CHAT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^-?\d+$/.test(value));

  const chatIds = [...new Set([...staffChatIds, ...envChatIds])];

  if (!chatIds.length) {
    console.log('No staff Telegram accounts are linked and no TUNNEL_NOTIFY_CHAT_IDS are configured; notification skipped.');
    return;
  }

  const tokenResult = await pool.query("SELECT value FROM settings WHERE key = 'bot_token_encrypted'");
  const token = decrypt(tokenResult.rows[0]?.value);
  if (!token) throw new Error('The active bot token is not configured or could not be decrypted.');

  const bot = new Telegraf(token);
  const message = `رابط لوحة الدعم الجديد جاهز:\n${publicUrl}`;
  let sent = 0;
  for (const chatId of chatIds) {
    try {
      await bot.telegram.sendMessage(chatId, message, { disable_web_page_preview: true });
      sent += 1;
      console.log(`Tunnel URL notification sent to chat_id ${chatId}.`);
    } catch (error) {
      console.error(`Failed to notify chat_id ${chatId}: ${error.message}`);
    }
  }
  console.log(`Tunnel URL notifications completed: ${sent}/${chatIds.length} sent.`);
}

main()
  .catch((error) => {
    console.error(`Failed to send tunnel URL notifications: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

