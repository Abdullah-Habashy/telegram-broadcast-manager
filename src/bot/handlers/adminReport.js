const pool = require('../../config/db');
const { buildDailyReport } = require('../../utils/dailyReport');
const { lastTenDigits, SQL_TRANSLATE_DIGITS } = require('../../utils/phone');
const {
  SCIENCE_BUTTON, TECH_BUTTON, FOLLOWUP_BUTTON, STUDENT_MENU, TECH_ONLY_MENU, menuFor,
} = require('../studentMenu');

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

// نصوص زراير الطالب، مستوردة مش مكتوبة تاني — لو اتغيّر نص زرار في `studentMenu.js`
// مايفضلش هنا نص قديم يخلي الزرار يتبلع
const STUDENT_BUTTONS = new Set([SCIENCE_BUTTON, TECH_BUTTON, FOLLOWUP_BUTTON]);

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
const RESTORE_HINT = `\n\nابعت أي رسالة عادية عشان يرجع «${BUTTON_LABEL}».`;

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

  // رقم موبايل = تشخيص، مش تجربة. كيبورد الأدمن بيفضل مكانه
  if (/[0-9\u0660-\u0669\u06F0-\u06F9]{7,}/.test(arg)) return previewForPhone(ctx, arg);

  const forceFull = /^(كامل|مشترك|full)$/i.test(arg);
  const forceTech = /^(فني|مجاني|مش مشترك|tech)$/i.test(arg);
  const keyboard = forceFull ? STUDENT_MENU : forceTech ? TECH_ONLY_MENU : await menuFor(ctx.chat.id);
  const forced = forceFull || forceTech;
  const isFull = keyboard === STUDENT_MENU;

  return ctx.reply(
    '👇 دي قايمة الطالب زي ما هي.\n\n'
    + `الحالة: ${isFull ? 'مشترك' : 'مش مشترك'}`
    + (forced ? ' (بالعافية للتجربة)\n' : ' — دي حالتك الحقيقية على المنصة\n')
    + `الزراير: ${isFull ? `${SCIENCE_BUTTON} · ${TECH_BUTTON} · ${FOLLOWUP_BUTTON}` : TECH_BUTTON}\n\n`
    + 'دوس على أي زرار وهيرد عليك زي ما بيرد على الطالب بالظبط.\n'
    + 'وجرّب التانية كمان: «/preview_menu كامل» و«/preview_menu فني».'
    + RESTORE_HINT,
    { reply_markup: keyboard }
  );
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

    // تجربة قايمة الطالب — الأمر ده للأدمن بس، فمكانه هنا مش في هاندلر عام
    if (text === '/preview_menu' || text.startsWith('/preview_menu ')) {
      return sendMenuPreview(ctx, text.slice('/preview_menu'.length));
    }

    // باقي الأوامر (`/setforward` مثلًا) بتكمّل لهاندلراتها عادي
    if (text.startsWith('/')) return next();

    // **زراير الطالب بتعدّي من حساب الأدمن.** من غير الاستثناء ده الرد الافتراضي تحت
    // بيبلعها ويرجّع كيبورد الأدمن، فالأدمن مايقدرش يجرّب اللي الطالب عايشه أبدًا.
    // مافيش خطر: محادثته مالهاش تذكرة، فالضغط بيرد بس ومابيحوّلش حاجة
    if (STUDENT_BUTTONS.has(text)) return next();

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
