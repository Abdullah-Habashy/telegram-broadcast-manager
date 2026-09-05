const pool = require('../../config/db');
const { buildDailyReport } = require('../../utils/dailyReport');

// ---------- حساب الأدمن على البوت ----------
//
// **الأدمن = الحساب المربوط بـ `/setforward`** (`settings.forward_chat_id`) — نفس الحساب اللي
// بتتحوّل له كل رسالة جديدة بتوصل البوت. مصدر واحد للحقيقة: مافيش إعداد تاني يتنسى يتحدّث،
// ولو الربط اتنقل لحساب تاني بيبقى هو الأدمن تلقائيًا.
//
// وليه ده مهم: قبل الملف ده كانت أي رسالة من الحساب ده بتتعامل كأنها رسالة طالب — بتفتح تذكرة
// وتتوزّع على موظف وتولّع لونها أزرق. الميدلوير هنا بيمسك رسايله قبل `start.js` و`message.js`.
//
// **الزرار بيظهر له هو بس** بحكم طبيعته: كيبورد تيليجرام (`reply_markup`) بيتبعت لمحادثة
// واحدة، وقايمة الأوامر متسجّلة بنطاق `chat` على نفس المحادثة — فمفيش طالب بيشوف حاجة منهم.
const BUTTON_LABEL = '📊 التقرير اليومي';

const ADMIN_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: BUTTON_LABEL }]],
    resize_keyboard: true,
    is_persistent: true,
  },
};

// الميدلوير بيشتغل على **كل** رسالة داخلة، فقراءة الإعداد من القاعدة في كل مرة معناها استعلام
// زيادة على كل رسالة طالب. الكاش دقيقة واحدة: بيقلّل الحمل، وتأخير دقيقة بعد نقل الربط مقبول
const CACHE_MS = 60 * 1000;
let cachedChatId = null;
let cachedAt = 0;

async function getAdminChatId() {
  if (Date.now() - cachedAt < CACHE_MS) return cachedChatId;
  const result = await pool.query("SELECT value FROM settings WHERE key = 'forward_chat_id'");
  cachedChatId = result.rows[0]?.value || null;
  cachedAt = Date.now();
  return cachedChatId;
}

// بعد `/setforward` مباشرةً الربط بيتغيّر، والكاش القديم بيخلّي الحساب الجديد يستنى دقيقة قبل
// ما الزرار يشتغل معاه — الدالة دي بتصفّره من `forwarding.js` وقت الربط
function invalidateAdminChatCache() {
  cachedAt = 0;
}

// قايمة أوامر بنطاق محادثة واحدة. القايمة العامة **فاضية بطلب صاحب المشروع** (شوف
// `botManager.js`)، والنطاق هنا مابيلمسهاش: تيليجرام بيخزّن كل نطاق لوحده، فالطالب بيفضل
// شايف الزرار الأزرق مختفي زي ما هو
async function ensureAdminCommandMenu(telegram, chatId) {
  try {
    await telegram.setMyCommands(
      [{ command: 'daily_report', description: BUTTON_LABEL }],
      { scope: { type: 'chat', chat_id: Number(chatId) } }
    );
  } catch (error) {
    // فشل القايمة مايمنعش الزرار ولا الأمر من الشغل
    console.error('⚠️ Failed to set the admin command menu:', error.message);
  }
}

async function sendDailyReport(ctx) {
  await ctx.replyWithChatAction('typing').catch(() => {});
  try {
    const chunks = await buildDailyReport();
    for (const [index, chunk] of chunks.entries()) {
      // الكيبورد بيتبعت مع آخر جزء بس عشان مايتكررش تحت كل رسالة
      await ctx.reply(chunk, index === chunks.length - 1 ? ADMIN_KEYBOARD : undefined);
    }
  } catch (error) {
    console.error('❌ Failed to build the daily report:', error.message);
    await ctx.reply('حصل خطأ أثناء تجهيز التقرير. حاول تاني بعد شوية.', ADMIN_KEYBOARD);
  }
}

function registerAdminReportHandler(bot) {
  bot.use(async (ctx, next) => {
    // المحادثات الخاصة بس: الربط نفسه مابيتمش إلا من محادثة خاصة، فأي جروب مش الأدمن
    if (!ctx.message || ctx.chat?.type !== 'private') return next();

    const adminChatId = await getAdminChatId();
    if (!adminChatId || String(ctx.chat.id) !== String(adminChatId)) return next();

    const text = (ctx.message.text || '').trim();

    if (text === BUTTON_LABEL || text === '/daily_report' || text.startsWith('/daily_report@')) {
      return sendDailyReport(ctx);
    }

    if (text === '/start' || text.startsWith('/start ')) {
      await ensureAdminCommandMenu(ctx.telegram, adminChatId);
      return ctx.reply(
        `أهلًا 👋\nالحساب ده هو أدمن البوت — بتوصله كل رسالة جديدة للبوت.\nاضغط «${BUTTON_LABEL}» تحت في أي وقت.`,
        ADMIN_KEYBOARD
      );
    }

    // باقي الأوامر (`/setforward` مثلًا) بتكمّل لهاندلراتها عادي
    if (text.startsWith('/')) return next();

    // أي رسالة تانية من الأدمن مش رسالة طالب: بتتوقف هنا عشان ماتفتحش تذكرة، والكيبورد
    // بيتبعت معاها عشان الزرار يبان من غير ما يحتاج `/start`
    return ctx.reply(`اضغط «${BUTTON_LABEL}» عشان يوصلك تقرير النهاردة.`, ADMIN_KEYBOARD);
  });
}

module.exports = registerAdminReportHandler;
module.exports.BUTTON_LABEL = BUTTON_LABEL;
module.exports.ADMIN_KEYBOARD = ADMIN_KEYBOARD;
module.exports.ensureAdminCommandMenu = ensureAdminCommandMenu;
module.exports.invalidateAdminChatCache = invalidateAdminChatCache;
