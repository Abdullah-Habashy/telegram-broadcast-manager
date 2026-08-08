const pool = require('../../config/db');

// عند /start: تسجيل تلقائي لجهة الاتصال (أو تحديث بياناتها لو كانت مسجّلة قبل كده)
module.exports = function registerStartHandler(bot) {
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const { username, first_name, last_name } = ctx.from;

    try {
      await pool.query(
        `INSERT INTO contacts (chat_id, telegram_username, first_name, last_name, source, last_contacted_at)
         VALUES ($1, $2, $3, $4, 'bot', NOW())
         ON CONFLICT (chat_id) DO UPDATE SET
           telegram_username = EXCLUDED.telegram_username,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           last_contacted_at = NOW()`,
        [chatId, username || null, first_name || null, last_name || null]
      );
      await ctx.reply('أهلاً بيك! ✅ تم تسجيلك بنجاح.');
    } catch (err) {
      console.error('❌ Failed to register a contact through /start:', err.message);
      await ctx.reply('حصل خطأ بسيط، جرب تاني كمان شوية 🙏');
    }
  });
};
