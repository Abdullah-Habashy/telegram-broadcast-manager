const crypto = require('crypto');
const pool = require('../../config/db');

function generateSetupCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function codesMatch(provided, stored) {
  const first = Buffer.from(String(provided || '').toUpperCase());
  const second = Buffer.from(String(stored || '').toUpperCase());
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

module.exports = function registerForwardingHandler(bot) {
  bot.command('setforward', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return ctx.reply('استخدم أمر الربط في محادثة خاصة مع البوت.');
    }

    const providedCode = ctx.message.text.trim().split(/\s+/)[1];
    if (!providedCode) {
      return ctx.reply('أرسل الأمر ومعه رمز الربط الموجود في إعدادات لوحة التحكم.');
    }

    try {
      const result = await pool.query("SELECT value FROM settings WHERE key = 'forward_setup_code'");
      const storedCode = result.rows[0]?.value;

      if (!storedCode || !codesMatch(providedCode, storedCode)) {
        return ctx.reply('رمز الربط غير صحيح أو انتهت صلاحيته.');
      }

      const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
        || ctx.from.username
        || String(ctx.chat.id);
      const nextCode = generateSetupCode();

      await pool.query(
        `UPDATE settings SET value = CASE key
          WHEN 'forward_chat_id' THEN $1
          WHEN 'forward_chat_name' THEN $2
          WHEN 'forwarding_enabled' THEN 'true'
          WHEN 'forward_setup_code' THEN $3
        END
        WHERE key IN ('forward_chat_id', 'forward_chat_name', 'forwarding_enabled', 'forward_setup_code')`,
        [String(ctx.chat.id), displayName, nextCode]
      );

      await ctx.reply('✅ تم ربط هذا الحساب. ستصل إليه الرسائل الجديدة الواردة للبوت.');
      console.log(`✅ Incoming-message forwarding target linked: ${displayName}`);
    } catch (error) {
      console.error('❌ Failed to link forwarding target:', error.message);
      await ctx.reply('حدث خطأ أثناء ربط الحساب. حاول مرة أخرى.');
    }
  });
};
