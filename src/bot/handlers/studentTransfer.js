const pool = require('../../config/db');
const { TEAMS } = require('../../utils/teams');
const {
  SCIENCE_BUTTON, TECH_BUTTON, FOLLOWUP_BUTTON, STUDENT_MENU_OPTIONS,
} = require('../studentMenu');

// ===================== الطالب بيحوّل نفسه لتيم متخصص =====================
//
// قبل كده التحويل كان بضغطة موظف المتابعة بس: الطالب يسأل سؤال علمي، الموظف يقرا ويقرر
// يحوّله. يعني السؤال بيستنى دور موظف المتابعة الأول عشان يوصل للي المفروض يجاوبه.
// دلوقتي الطالب بيختار بنفسه، والسؤال بيوصل للمتخصص من غير وسيط.
//
// الطالب دلوقتي شايف قايمة ثابتة تحت مربع الكتابة فيها التلات زراير (`bot/studentMenu.js`):
// الدعم العلمي، الدعم الفني، وتيم المتابعة. **قايمة أوامر البوت الزرقا لسه فاضية** بطلب صاحب
// المشروع — دي كيبورد رسايل، حاجة تانية خالص. والأوامر والكتابة العادية شغالين زي ما هم لأن
// مش كل طالب بيستخدم الزراير.
//
// **وزرار «تيم المتابعة» هو طريق الرجوع بتاع الطالب.** إرجاع الموظف المتخصص من اللوحة شغّال
// زي ما هو ومالوش علاقة بده — الاتنين بينادوا نفس `performReturn`، فلو الطالب اختار تيم
// ونسي يرجع، المتخصص بيرجّعه يدويًا زي الأول بالظبط.
//
// نفس ترتيب studentReport.js: الهاندلر ده **قبل message.js** عشان كلمة "سؤال علمي" ما تتسجّلش
// كرسالة واردة عند موظف المتابعة — هي أمر مش سؤال.

// التذكرة واحدة لكل جهة اتصال (قيد UNIQUE على contact_id)، فمفيش لبس في "أنهي تذكرة"
const TICKET_SQL = `
  SELECT t.id, t.transfer_team
  FROM tickets t JOIN contacts c ON c.id = t.contact_id
  WHERE c.chat_id = $1 LIMIT 1`;

// نص واحد لحالة "التذكرة مع موظف واتساب": بيتقال للطالب سواء طلب تيم متخصص أو طلب يرجع
// للمتابعة، والحالتين ممنوعتين بنفس السبب
const WHATSAPP_HOLD_REPLY = 'فيه حد من الفريق بيكلمك دلوقتي 💬 كمّل معاه وهو هيوصّلك للي محتاجه.';

// الرد بيتغيّر حسب سبب المنع — "مش هينفع" لوحدها بتخلي الطالب يعيد المحاولة من غير فايدة
function blockedReply(team, holderTeamKey) {
  if (holderTeamKey === team.key) {
    return `سؤالك مع ${team.label} بالفعل ${team.icon} — اكتبه وهيوصله.`;
  }
  if (holderTeamKey === 'whatsapp') {
    return WHATSAPP_HOLD_REPLY;
  }
  return 'فيه حد بيتابع معاك دلوقتي — كمّل معاه وهو هيوصّلك.';
}

module.exports = function registerStudentTransferHandler(bot) {
  const requestTeam = async (ctx, teamKey) => {
    if (ctx.chat.type !== 'private') return;
    const team = TEAMS[teamKey];

    try {
      const { rows } = await pool.query(TICKET_SQL, [ctx.chat.id]);
      const ticket = rows[0];
      // مفيش تذكرة = الطالب ما بعتش ولا رسالة لسه. التحويل قبل أي سؤال بيدّي المتخصص
      // محادثة فاضية، فبنطلب السؤال الأول
      if (!ticket) {
        return ctx.reply(
          `اكتب ${teamKey === 'science' ? 'سؤالك' : 'مشكلتك'} الأول وهوصّله لـ${team.label} على طول.`,
          STUDENT_MENU_OPTIONS
        );
      }
      // **لاحظ:** المنع الحقيقي جوه performTransfer (transferGuard) تحت قفل الصف. الفحص هنا
      // عشان الرسالة تبقى مفهومة للطالب بس — مش عشان الحماية، والاتنين مش بديل لبعض.
      // التبديل بين العلمي والفني مسموح: الطالب سأل سؤال علمي وبعدين اتعطّل عنده حاجة تقنية
      if (ticket.transfer_team === team.key || ticket.transfer_team === 'whatsapp') {
        return ctx.reply(blockedReply(team, ticket.transfer_team), STUDENT_MENU_OPTIONS);
      }

      // **require كسول عن قصد.** botManager بيحمّل الهاندلر ده وقت التشغيل، والكنترولر بيحمّل
      // botManager — فالاستيراد من فوق بيعمل دايرة بترجّع كائن نصّه فاضي، و`botManager.getBot`
      // بترمي TypeError وقت أول تحويل. الفحص النحوي مابيشوفش ده خالص.
      const { performTransfer } = require('../../controllers/teams.controller');
      const result = await performTransfer({ ticketId: ticket.id, teamKey, by: 'student' });

      // مفيش حد حاضر: performTransfer بعت رسالة الغياب للطالب بنفسه، فمنبعتش تانية فوقها
      if (!result.ok) {
        if (result.offline) return;
        return ctx.reply(blockedReply(team, result.team?.key), STUDENT_MENU_OPTIONS);
      }

      return ctx.reply(
        `تمام ${team.icon} ${teamKey === 'science' ? 'سؤالك رايح للتيم العلمي' : 'مشكلتك رايحة للدعم الفني'}.\n`
        + `اكتب${teamKey === 'science' ? 'ه' : 'ها'} دلوقتي وهيرد عليك مباشرة.\n`
        + `ولما تخلص اضغط «${FOLLOWUP_BUTTON}» عشان ترجع لفريق المتابعة.`,
        STUDENT_MENU_OPTIONS
      );
    } catch (error) {
      console.error('❌ Failed to transfer a ticket at the student request:', error.message);
      return ctx.reply('حصلت مشكلة وإحنا بنحوّل طلبك. جرّب تاني بعد شوية.', STUDENT_MENU_OPTIONS);
    }
  };

  // ---------- الرجوع لتيم المتابعة ----------
  //
  // تيم المتابعة هو الوضع الافتراضي: الطالب اللي مش محوّل لتيم متخصص هو معاهم أصلًا، فالزرار
  // في الحالة دي بيأكّد له مكانه بدل ما يسيبه محتار
  const requestFollowUp = async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    try {
      const { rows } = await pool.query(TICKET_SQL, [ctx.chat.id]);
      const ticket = rows[0];
      if (!ticket || !ticket.transfer_team) {
        return ctx.reply('إنت مع تيم المتابعة ✅ اكتب اللي محتاجه وهيوصلهم.', STUDENT_MENU_OPTIONS);
      }
      // نفس قاعدة التحويل: الطالب مايسحبش نفسه من موظف الواتساب. دي محادثة إقناع مع طالب
      // مش مشترك، والخروج منها بيحصل لوحده أول ما يشترك
      if (ticket.transfer_team === 'whatsapp') {
        return ctx.reply(WHATSAPP_HOLD_REPLY, STUDENT_MENU_OPTIONS);
      }

      // **require كسول عن قصد** — نفس دايرة الاستيراد اللي في التحويل فوق بالظبط
      const { performReturn } = require('../../controllers/teams.controller');
      const result = await performReturn({ ticketId: ticket.id, by: 'student' });
      if (!result.ok) {
        return ctx.reply('إنت مع تيم المتابعة ✅ اكتب اللي محتاجه وهيوصلهم.', STUDENT_MENU_OPTIONS);
      }

      return ctx.reply(
        'تمام 👥 رجّعناك لتيم المتابعة. اكتب اللي محتاجه وهيرد عليك.',
        STUDENT_MENU_OPTIONS
      );
    } catch (error) {
      console.error('❌ Failed to return a ticket at the student request:', error.message);
      return ctx.reply('حصلت مشكلة وإحنا بنرجّعك للمتابعة. جرّب تاني بعد شوية.', STUDENT_MENU_OPTIONS);
    }
  };

  bot.command('science', (ctx) => requestTeam(ctx, 'science'));
  bot.command('tech', (ctx) => requestTeam(ctx, 'tech'));
  bot.command('followup', (ctx) => requestFollowUp(ctx));

  // زراير القايمة — مطابقة نص كامل على الثوابت نفسها، فلو اتغيّر نص زرار في `studentMenu.js`
  // مايفضلش هنا نص قديم مالوش زرار
  bot.hears(SCIENCE_BUTTON, (ctx) => requestTeam(ctx, 'science'));
  bot.hears(TECH_BUTTON, (ctx) => requestTeam(ctx, 'tech'));
  bot.hears(FOLLOWUP_BUTTON, (ctx) => requestFollowUp(ctx));

  // الكتابة بالعربي: الطالب اللي مش هيلاقي الزرار هيكتب. الأنماط **مقفولة على الجملة كاملة**
  // عشان "عندي سؤال علمي في الباب التالت" تفضل سؤال عادي يروح لموظف المتابعة، مش أمر تحويل
  bot.hears(/^\s*(سؤال\s*علمي|تيم\s*علمي|التيم\s*العلمي|الدعم\s*العلمي|🧪\s*سؤال\s*علمي)\s*$/i, (ctx) => requestTeam(ctx, 'science'));
  bot.hears(/^\s*(دعم\s*فني|مشكلة\s*تقنية|الدعم\s*الفني|🛠️?\s*دعم\s*فني)\s*$/i, (ctx) => requestTeam(ctx, 'tech'));
  bot.hears(/^\s*(تيم\s*المتابعة|فريق\s*المتابعة|المتابعة|رجعني\s*للمتابعة)\s*$/i, (ctx) => requestFollowUp(ctx));
};
