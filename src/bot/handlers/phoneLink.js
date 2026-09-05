const pool = require('../../config/db');
const { lastTenDigits, SQL_TRANSLATE_DIGITS } = require('../../utils/phone');
const { STUDENT_MENU_OPTIONS } = require('../studentMenu');

// ===================== البوت بيطلب الرقم عشان يعرف الطالب =====================
//
// **المشكلة:** تيليجرام مابيدّيش رقم الموبايل عند /start — بيدّي اسم العرض واليوزر بس.
// والجسر الوحيد بين حساب تيليجرام وحساب المنصة هو telegram_chat_id، والطالب بيسجّله **على
// المنصة**. فاللي دخل البوت من غير ما يعمل كده بيفضل مجهول مهما كلّمنا.
//
// قِسناها: ٢٠٩ جهة اتصال كلّمت البوت ومش معروفة، ٢٠٥ منهم جُم من تيليجرام و٤ بس عندنا
// تليفونهم. والمطابقة بالاسم مش حل — ٦٪ بس بيطابقوا طالب واحد، وأسماؤهم "Marwan" و"🌹..🌹".
//
// **الحل:** زرار `request_contact` بتاع تيليجرام. ضغطة واحدة، من غير كتابة، والرقم بيوصل
// موثّقًا من تيليجرام نفسه — مش من كتابة الطالب اللي ممكن يغلط فيها.

// **بنسأل مرة واحدة بس.** اللي مايشاركش رقمه مش عايز يشاركه، وتكرار الطلب مع كل رسالة
// بيتحوّل لمضايقة. `phone_request_sent_at` هي العلامة، ومابتتصفّرش
const NEEDS_ASK_SQL = `
  SELECT c.id, c.phone_request_sent_at,
    EXISTS (SELECT 1 FROM tafra_students s WHERE s.telegram_chat_id = c.chat_id) AS linked
  FROM contacts c WHERE c.chat_id = $1`;

const MATCH_SQL = `
  SELECT tafra_student_id, name, telegram_chat_id
  FROM tafra_students
  WHERE RIGHT(REGEXP_REPLACE(translate(phone, ${SQL_TRANSLATE_DIGITS}), '[^0-9]', '', 'g'), 10) = $1`;

async function loadSettings() {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('phone_request_enabled', 'phone_request_message')");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

module.exports = function registerPhoneLinkHandler(bot) {
  // ---------- استقبال الرقم المشارَك ----------
  bot.on('contact', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const contact = ctx.message.contact;

    // **لازم يكون رقمه هو.** تيليجرام بيسمح بمشاركة جهة اتصال أي حد، ومن غير الفحص ده كان
    // ممكن حد يشارك رقم زميله ويترّبط بحسابه — يعني يشوف درجاته وتقريره
    if (!contact || String(contact.user_id || '') !== String(ctx.from.id)) {
      await ctx.reply('ده رقم حد تاني 🙂 اضغط الزرار عشان يتبعت رقمك إنت.');
      return;
    }

    const phone = lastTenDigits(contact.phone_number);
    if (!phone) {
      await ctx.reply('الرقم ده مش واضح. اكتبلنا سؤالك عادي وهنساعدك.',
        STUDENT_MENU_OPTIONS);
      return;
    }

    try {
      // الرقم بيتسجّل على جهة الاتصال في كل الحالات — حتى لو ما طابقش طالب. ده بيدّي الموظف
      // وسيلة تواصل، وبيخلّي أي مطابقة مستقبلية ممكنة
      await pool.query('UPDATE contacts SET phone = COALESCE(NULLIF(TRIM(phone), \'\'), $2) WHERE chat_id = $1',
        [ctx.chat.id, contact.phone_number]);

      const { rows } = await pool.query(MATCH_SQL, [phone]);
      // كيبورد مشاركة الرقم لازم يروح بعد ما يتستخدم، وبدل ما يسيب الطالب من غير أي زرار بيرجع لقايمة
      // الطالب العادية — الكيبورد الجديد بيحل محل القديم في تيليجرام
      const menu = STUDENT_MENU_OPTIONS;

      if (!rows.length) {
        // مش على المنصة: مايستاهلش رسالة إحباط. بنشكره ونسيب الرسالة تكمّل لموظف عادي
        await ctx.reply('تمام، وصلنا رقمك ✅ اكتبلنا اللي محتاجه وهنساعدك.', menu);
        return;
      }
      if (rows.length > 1) {
        // ٦٩ رقم متكرر على المنصة (إخوات على تليفون الأب). التخمين هنا يعني إن طالب يشوف
        // بيانات أخوه — فبيروح لموظف، والرسالة بتكمّل عشان تفتح تذكرة
        await ctx.reply('الرقم ده مسجّل لأكتر من طالب، فحد من الفريق هيتأكد معاك.', menu);
        return next();
      }

      const student = rows[0];
      if (student.telegram_chat_id && String(student.telegram_chat_id) !== String(ctx.chat.id)) {
        await ctx.reply('الرقم ده مربوط بحساب تاني على تيليجرام. حد من الفريق هيتواصل معاك.', menu);
        return next();
      }

      await pool.query('UPDATE tafra_students SET telegram_chat_id = $1 WHERE tafra_student_id = $2',
        [ctx.chat.id, student.tafra_student_id]);
      const firstName = (student.name || '').trim().split(/\s+/)[0];
      await ctx.reply(`${firstName ? 'أهلًا ' + firstName + '! ' : ''}عرفناك ✅\n`
        + 'دلوقتي تقدر تكتب /report في أي وقت وتشوف مستواك وتقريرك.', menu);
    } catch (error) {
      console.error('❌ Failed to link a shared contact:', error.message);
      await ctx.reply('حصلت مشكلة وإحنا بنسجّل رقمك. جرّب تاني بعد شوية.',
        STUDENT_MENU_OPTIONS);
    }
  });

  // ---------- الطلب نفسه ----------
  // **بيمرّر next() دايمًا.** ده مش هاندلر بيتعامل مع الرسالة، ده بيضيف طلب جنبها — الرسالة
  // لازم تكمّل لـ message.js وتفتح تذكرة زي أي رسالة عادية
  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || ctx.message.contact) return next();
    try {
      const { rows } = await pool.query(NEEDS_ASK_SQL, [ctx.chat.id]);
      const contact = rows[0];
      // مفيش صف = أول رسالة خالص، وmessage.js هو اللي بيعمله. بنسيبها وهنسأله في اللي بعدها،
      // عشان رسالة الترحيب ورسالة بره المواعيد ما يتكوّموش مع الطلب في نفس اللحظة
      if (!contact || contact.linked || contact.phone_request_sent_at) return next();

      const settings = await loadSettings();
      if (settings.phone_request_enabled !== 'true' || !settings.phone_request_message) return next();

      // العلامة بتتحط **قبل** الإرسال: لو الإرسال فشل، أسوأ نتيجة إننا ما سألناش — أهون من
      // إن الفشل يتكرر فيتبعت الطلب مرتين وتلاتة
      await pool.query('UPDATE contacts SET phone_request_sent_at = NOW() WHERE id = $1', [contact.id]);
      await ctx.reply(settings.phone_request_message, {
        reply_markup: {
          keyboard: [[{ text: '📱 شارك رقمك', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
    } catch (error) {
      // فشل الطلب مايوقّفش الرسالة عن الوصول للموظف
      console.error('❌ Failed to ask for a phone number:', error.message);
    }
    return next();
  });
};
