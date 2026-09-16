const pool = require('../../config/db');
const { buildDailyReport } = require('../../utils/dailyReport');
const { lastTenDigits, SQL_TRANSLATE_DIGITS } = require('../../utils/phone');
const {
  DEFAULT_STUDENT_COMMANDS, SUBSCRIBED_STUDENT_COMMANDS,
} = require('../studentMenu');
const { isSubscribedStudent } = require('../../utils/studentAccess');

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

// القايمة الزرقا بتتبعت مرة واحدة كل تشغيل — `setMyCommands` نداء شبكة، ومفيش داعي يتكرر
// مع كل رسالة من الأدمن
let commandMenuSynced = false;

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
//
// **الأوامر اللي بتاخد معامل متكتبة كأوامر مستقلة**: تيليجرام بيبعت الأمر زي ما هو أول ما
// تدوس عليه في القايمة، فـ`/preview_menu كامل` كان هيحتاج الأدمن يكمّل الكتابة بإيده —
// والقايمة أصلًا موجودة عشان مايكتبش
const ADMIN_COMMANDS = [
  { command: 'daily_report', description: BUTTON_LABEL },
  { command: 'preview_menu', description: '👇 شوف قايمة الطالب بحالتك' },
  { command: 'preview_full', description: '🧪 جرّب قايمة الطالب المشترك' },
  { command: 'preview_tech', description: '🛠️ جرّب قايمة الطالب غير المشترك' },
];

async function ensureAdminCommandMenu(telegram, chatId) {
  try {
    await telegram.setMyCommands(
      ADMIN_COMMANDS,
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


// ---------- تجربة زراير الطالب من حساب الأدمن ----------
//
// **حساب الأدمن مش بيشوف قايمة الطالب أبدًا** — الميدلوير تحت بيمسك رسايله قبل ما توصل
// `message.js`، فمفيش رد آلي بيتبعتله، والكيبورد بتاعه هو زرار التقرير. يعني مفيش طريقة
// طبيعية يجرّب بيها اللي الطالب شايفه غير إنه يستخدم حساب تليجرام تاني.
//
// الأمر ده بيحل ده: بيبعت للأدمن **نفس** الكيبورد بحاله، والزراير شغّالة فعلًا لأن
// الميدلوير بيعدّيها (شوف `STUDENT_BUTTONS` تحت).
//
//   /preview_menu             → الكيبورد بحالتك إنت الحقيقية
//   /preview_menu كامل        → كيبورد المشترك بالعافية (التلات زراير)
//   /preview_menu فني         → كيبورد غير المشترك بالعافية (زرار واحد)
//   /preview_menu 01012345678 → **تشخيص**: الطالب ده شايف إيه وليه، من غير ما تلمس كيبوردك
//
// **الحالتين بالعافية لازمين** لأن حساب الأدمن نفسه مشترك على المنصة — من غيرهم مش
// هيشوف غير نص الحالات.
//
// **الضغط مابيفتحش تذاكر:** محادثة الأدمن مالهاش تذكرة، و`requestTeam` بيرد "اكتب سؤالك
// الأول" من غير ما يحوّل حاجة. فالتجربة آمنة ومابتلوّثش صندوق الدعم.
// عرض قايمة الأوامر زي ما الطالب هيشوفها لما يدوس زرار Menu
function renderCommands(commands) {
  return commands.map((c) => `   /${c.command}  —  ${c.description}`).join('\n');
}

// تشخيص طالب بالرقم — ده اللي بيجاوب "ليه الطالب ده مش شايف الدعم العلمي؟"
async function previewForPhone(ctx, rawPhone) {
  const phone = lastTenDigits(rawPhone);
  if (!phone) return ctx.reply('الرقم ده مش واضح. اكتبه بالشكل 01012345678.', ADMIN_KEYBOARD);
  // `lastTenDigits` بتشيل الصفر، والرقم اللي الأدمن كتبه بيرجعله زي ما هو عشان يتأكد
  const shown = `0${phone}`;

  const { rows } = await pool.query(
    `SELECT s.name, s.telegram_chat_id,
            COALESCE((SELECT string_agg(b.name || (CASE WHEN b.grants_support THEN ' ✅' ELSE ' ❌' END), E'\n   • ')
              FROM tafra_enrollments e JOIN tafra_bootcamps b ON b.tafra_bootcamp_id = e.tafra_bootcamp_id
              WHERE e.tafra_student_id = s.tafra_student_id AND e.enrollment_type IN ('enroll', 'renew')), '(مفيش)') AS courses,
            EXISTS (SELECT 1 FROM tafra_enrollments e2 JOIN tafra_bootcamps b2 ON b2.tafra_bootcamp_id = e2.tafra_bootcamp_id
              WHERE e2.tafra_student_id = s.tafra_student_id AND e2.enrollment_type IN ('enroll', 'renew') AND b2.grants_support) AS subscribed
     FROM tafra_students s
     WHERE RIGHT(REGEXP_REPLACE(translate(s.phone, ${SQL_TRANSLATE_DIGITS}), '[^0-9]', '', 'g'), 10) = $1
     LIMIT 1`,
    [phone]
  );

  if (!rows.length) {
    return ctx.reply(
      `📱 ${shown}\nمالقيناش الرقم ده على المنصة.\n\nيعني: مش مشترك → شايف «${TECH_BUTTON}» بس.`,
      ADMIN_KEYBOARD
    );
  }

  const student = rows[0];
  const buttons = student.subscribed
    ? `${SCIENCE_BUTTON} · ${TECH_BUTTON} · ${FOLLOWUP_BUTTON}`
    : TECH_BUTTON;
  return ctx.reply(
    `📱 ${shown}\n`
    + `الطالب: ${student.name || '(بلا اسم)'}\n`
    + `على البوت: ${student.telegram_chat_id ? 'أيوة' : 'لأ (ماربطش حسابه)'}\n\n`
    + `الكورسات:\n   • ${student.courses}\n\n`
    + `الحالة: ${student.subscribed ? 'مشترك ✅' : 'مش مشترك'}\n`
    + `بيشوف: ${buttons}`,
    ADMIN_KEYBOARD
  );
}

async function sendMenuPreview(ctx, argument) {
  const arg = (argument || '').trim();

  // رقم موبايل = تشخيص لطالب بعينه، مش معاينة
  if (/[0-9\u0660-\u0669\u06F0-\u06F9]{7,}/.test(arg)) return previewForPhone(ctx, arg);

  const forceFull = /^(كامل|مشترك|full)$/i.test(arg);
  const forceTech = /^(فني|مجاني|مش مشترك|tech)$/i.test(arg);
  const isFull = forceFull || (!forceTech && await isSubscribedStudent(ctx.chat.id));
  const forced = forceFull || forceTech;

  return ctx.reply(
    'دي قايمة الطالب — بتظهر له لما يدوس زرار «Menu» جنب مربع الكتابة.\n\n'
    + `الحالة: ${isFull ? 'مشترك' : 'مش مشترك'}`
    + (forced ? ' (بالعافية للتجربة)\n\n' : ' — دي حالتك الحقيقية على المنصة\n\n')
    + renderCommands(isFull ? SUBSCRIBED_STUDENT_COMMANDS : DEFAULT_STUDENT_COMMANDS)
    + '\n\nالأوامر دي شغالة عندك إنت كمان — جرّب /tech.\n'
    + 'وشوف التانية: /preview_full و /preview_tech.',
    ADMIN_KEYBOARD
  );
}

function registerAdminReportHandler(bot) {
  bot.use(async (ctx, next) => {
    // المحادثات الخاصة بس: الربط نفسه مابيتمش إلا من محادثة خاصة، فأي جروب مش الأدمن
    if (!ctx.message || ctx.chat?.type !== 'private') return next();

    const adminChatId = await getAdminChatId();
    if (!adminChatId || String(ctx.chat.id) !== String(adminChatId)) return next();

    // **القايمة بتتظبط لوحدها مرة كل تشغيل.** كانت بتتظبط في `/start` بس، يعني أي أمر جديد
    // بيتضاف هنا مايبانش عند الأدمن غير لما يفتكر يبعت `/start` — وهو مش عارف إنه محتاج
    if (!commandMenuSynced) {
      commandMenuSynced = true;
      await ensureAdminCommandMenu(ctx.telegram, adminChatId);
    }

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

    // تجربة قايمة الطالب — الأوامر دي للأدمن بس، فمكانها هنا مش في هاندلر عام
    if (text === '/preview_menu' || text.startsWith('/preview_menu ')) {
      return sendMenuPreview(ctx, text.slice('/preview_menu'.length));
    }
    // نسختين مستقلتين عشان يتدوس عليهم من القايمة على طول من غير كتابة معامل
    if (text === '/preview_full' || text.startsWith('/preview_full@')) return sendMenuPreview(ctx, 'كامل');
    if (text === '/preview_tech' || text.startsWith('/preview_tech@')) return sendMenuPreview(ctx, 'فني');

    // باقي الأوامر (`/setforward` مثلًا) بتكمّل لهاندلراتها عادي
    if (text.startsWith('/')) return next();

    // الزراير بقت أوامر (`/science` و`/tech`)، والأوامر بتعدّي فوق أصلًا — فمفيش
    // استثناء محتاج هنا

    // أي رسالة تانية من الأدمن مش رسالة طالب: بتتوقف هنا عشان ماتفتحش تذكرة، والكيبورد
    // بيتبعت معاها عشان الزرار يبان من غير ما يحتاج `/start`
    return ctx.reply(`اضغط «${BUTTON_LABEL}» عشان يوصلك تقرير النهاردة.`, ADMIN_KEYBOARD);
  });
}

module.exports = registerAdminReportHandler;
module.exports.BUTTON_LABEL = BUTTON_LABEL;
module.exports.ADMIN_KEYBOARD = ADMIN_KEYBOARD;
module.exports.ensureAdminCommandMenu = ensureAdminCommandMenu;
module.exports.ADMIN_COMMANDS = ADMIN_COMMANDS;
module.exports.invalidateAdminChatCache = invalidateAdminChatCache;
