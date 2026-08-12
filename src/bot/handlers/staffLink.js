const crypto = require('crypto');
const pool = require('../../config/db');

function generateLinkCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function codesMatch(provided, stored) {
  const first = Buffer.from(String(provided || '').toUpperCase());
  const second = Buffer.from(String(stored || '').toUpperCase());
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

// ربط حساب موظف (مدير أو موظف دعم) على لوحة التحكم بحسابه الشخصي على تيليجرام — مرة واحدة بس،
// عن طريق كود بيولّده الأدمن من جدول الفريق ويدّيه للموظف. بعد الربط بيوصله تلقائيًا أي إشعار
// تشغيلي (زي رابط Tunnel الجديد) على تيليجرام حتى لو مسجّلش دخول على لوحة التحكم
function registerStaffLinkHandler(bot) {
  bot.command('linkstaff', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      return ctx.reply('استخدم أمر الربط في محادثة خاصة مع البوت.');
    }

    const providedCode = ctx.message.text.trim().split(/\s+/)[1];
    if (!providedCode) {
      return ctx.reply('أرسل الأمر ومعه كود الربط اللي اداهولك المدير، مثال:\n/linkstaff ABCD1234');
    }

    try {
      const codeResult = await pool.query(
        'SELECT id, name, telegram_link_code FROM users WHERE telegram_link_code IS NOT NULL AND is_active = TRUE'
      );
      const user = codeResult.rows.find((row) => codesMatch(providedCode, row.telegram_link_code));

      if (!user) {
        return ctx.reply('كود الربط غير صحيح أو انتهت صلاحيته. اطلب كود جديد من المدير.');
      }

      await pool.query(
        'UPDATE users SET telegram_chat_id = $1, telegram_link_code = NULL WHERE id = $2',
        [ctx.chat.id, user.id]
      );

      await ctx.reply(`✅ تم ربط حسابك "${user.name}" بنجاح. هتوصلك إشعارات تشغيلية هنا تلقائيًا.`);
      console.log(`✅ Staff Telegram link established for user #${user.id} (${user.name}).`);
    } catch (error) {
      console.error('❌ Failed to link staff Telegram account:', error.message);
      await ctx.reply('حصل خطأ أثناء الربط. حاول مرة أخرى.');
    }
  });
}

module.exports = registerStaffLinkHandler;
module.exports.generateLinkCode = generateLinkCode;
