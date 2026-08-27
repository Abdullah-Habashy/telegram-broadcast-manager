const crypto = require('crypto');
const pool = require('../../config/db');

// ===================== الطالب يطلب تقريره بنفسه =====================
//
// **ليه ده موجود:** التقرير كان بيتبعت يدويًا من الموظف — واتبعت مرة واحدة من يوم ما اتبنى.
// أي حاجة محتاجة موظف يفتكرها لكل طالب مش هتحصل. هنا الطالب بيطلبها بنفسه في أي وقت.
//
// **ليه الهاندلر ده قبل message.js في الترتيب:** لو بعده، ضغطة /report كانت هتتسجّل كرسالة
// واردة، فالتذكرة تولّع أزرق والموظف يفتحها يلاقي كلمة "report" — ضوضاء بعدد الطلاب × عدد
// المرات. الهاندلر بيوقف الرسالة عنده ومابينادّيش next() إلا لما يكون في محلها.

// الطالب اللي مش مربوط بيتساله عن تليفونه. الانتظار في الذاكرة مش في القاعدة: أسوأ حالة إن
// السيرفر يعيد التشغيل وهو مستني، ووقتها بيدوس الزرار تاني — مش مبرر لعمود وجدول
const awaitingPhone = new Map();
const AWAIT_MS = 10 * 60 * 1000;

function isAwaiting(chatId) {
  const until = awaitingPhone.get(chatId);
  if (!until) return false;
  if (Date.now() > until) { awaitingPhone.delete(chatId); return false; }
  return true;
}

// آخر ١٠ أرقام بس: نفس التليفون متخزّن بأشكال مختلفة (+٢٠، ٠٠٢٠، من غير صفر) في المنصة وفي
// اللي الطالب بيكتبه، والمقارنة الحرفية كانت هتفشل مع أغلبهم
function normalizePhone(raw) {
  // الطالب بيكتب من كيبورد عربي غالبًا فبيبعت ٠١٠... مش 010... والتحويل لازم يحصل على
  // الاتنين: اللي هو كتبه، واللي متخزّن في المنصة — وإلا المطابقة بتفشل رغم إن الرقمين واحد
  const ascii = String(raw || '').replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
  const digits = ascii.replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function reportUrl(token) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return `${base}/me/${token}`;
}

// التوكن بيتعمل مرة واحدة وبيفضل — الطالب يقدر يحفظ الرابط ويفتحه في أي وقت وهو بيتحدّث لوحده
async function ensureToken(student) {
  if (student.report_token) return student.report_token;
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'UPDATE tafra_students SET report_token = $1, report_token_created_at = NOW() WHERE tafra_student_id = $2',
    [token, student.tafra_student_id]
  );
  return token;
}

async function findLinkedStudent(chatId) {
  const { rows } = await pool.query(
    `SELECT tafra_student_id, name, report_token FROM tafra_students
     WHERE telegram_chat_id = $1 LIMIT 1`, [chatId]);
  return rows[0] || null;
}

async function deliverReport(ctx, student) {
  const token = await ensureToken(student);
  const firstName = (student.name || '').trim().split(/\s+/)[0];
  await ctx.reply(
    `${firstName ? firstName + '، ' : ''}ده تقريرك 👇\n\n`
    + `فيه مستواك في الاختبارات، والدروس اللي خلّصتها، واللي محتاج مراجعة، والخطوة اللي بعدها.\n\n`
    + `${reportUrl(token)}\n\n`
    + `احفظ الرابط — بيتحدّث لوحده في أي وقت تفتحه.`,
    { link_preview_options: { is_disabled: true } }
  );
}

function askForPhone(ctx) {
  awaitingPhone.set(ctx.chat.id, Date.now() + AWAIT_MS);
  return ctx.reply(
    'عشان أطلّعلك تقريرك، محتاج أعرف حسابك على المنصة.\n\n'
    + 'ابعتلي **رقم الموبايل** اللي مسجّل بيه على منصة طفرة، وهربطه بحسابك هنا مرة واحدة بس.',
    { parse_mode: 'Markdown' }
  );
}

module.exports = function registerStudentReportHandler(bot) {
  const handleRequest = async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    try {
      const student = await findLinkedStudent(ctx.chat.id);
      if (student) return await deliverReport(ctx, student);
      return await askForPhone(ctx);
    } catch (error) {
      console.error('❌ Failed to serve the student report:', error.message);
      return ctx.reply('حصلت مشكلة وإحنا بنجهّز التقرير. جرّب تاني بعد شوية.');
    }
  };

  bot.command('report', handleRequest);
  // الزرار في قايمة البوت بيبعت /report، لكن الطالب اللي بيكتب بإيده بيكتب عربي — الاتنين شغالين
  bot.hears(/^\s*(تقريري|تقرير(ي)?\s*بتاعي|📊\s*تقريري)\s*$/i, handleRequest);

  // ---------- استقبال التليفون ----------
  // بيمرّر next() في كل حالة مش من ضمن الفلو، عشان الرسالة تكمّل لـ message.js عادي
  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || !isAwaiting(ctx.chat.id)) return next();

    const phone = normalizePhone(ctx.message.text);
    // مش تليفون أصلًا؟ يبقى غيّر رأيه وبيسأل حاجة تانية — نلغي الانتظار ونسيبها تروح للموظف
    if (!phone) { awaitingPhone.delete(ctx.chat.id); return next(); }

    try {
      const { rows } = await pool.query(
        `SELECT tafra_student_id, name, report_token, telegram_chat_id
         FROM tafra_students
         WHERE RIGHT(REGEXP_REPLACE(translate(phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 10) = $1`, [phone]);

      if (!rows.length) {
        // الانتظار بيفضل شغّال عشان يقدر يجرّب رقم تاني من غير ما يبدأ من الأول
        return ctx.reply('الرقم ده مش لاقيه على المنصة. اتأكد منه وابعته تاني، أو اكتبلي سؤالك وحد من الفريق هيساعدك.');
      }
      if (rows.length > 1) {
        // ٦٩ رقم متكرر في المنصة (إخوات على تليفون الأب غالبًا). التخمين هنا يعني إن طالب
        // يشوف تقرير أخوه — فبيروح لموظف، والرسالة بتكمّل لـ message.js عشان تفتح تذكرة
        awaitingPhone.delete(ctx.chat.id);
        await ctx.reply('الرقم ده مسجّل لأكتر من طالب، فمحتاج حد من الفريق يتأكد. هيتواصل معاك حالًا.');
        return next();
      }

      const student = rows[0];
      // الرقم مربوط بحساب تليجرام تاني: ممكن يكون الطالب غيّر رقمه، وممكن يكون بيحاول يوصل
      // لتقرير حد تاني. الحالتين محتاجين بني آدم يفصل فيهم
      if (student.telegram_chat_id && String(student.telegram_chat_id) !== String(ctx.chat.id)) {
        awaitingPhone.delete(ctx.chat.id);
        await ctx.reply('الرقم ده مربوط بحساب تاني على تيليجرام. حد من الفريق هيتواصل معاك عشان يظبطها.');
        return next();
      }

      await pool.query('UPDATE tafra_students SET telegram_chat_id = $1 WHERE tafra_student_id = $2',
        [ctx.chat.id, student.tafra_student_id]);
      awaitingPhone.delete(ctx.chat.id);
      await ctx.reply('اتربط ✅');
      return await deliverReport(ctx, student);
    } catch (error) {
      console.error('❌ Failed to link a student by phone:', error.message);
      awaitingPhone.delete(ctx.chat.id);
      return next();
    }
  });
};
