const pool = require('../../config/db');
const { TEAMS } = require('../../utils/teams');

// ===================== الطالب بيحوّل نفسه لتيم متخصص =====================
//
// قبل كده التحويل كان بضغطة موظف المتابعة بس: الطالب يسأل سؤال علمي، الموظف يقرا ويقرر
// يحوّله. يعني السؤال بيستنى دور موظف المتابعة الأول عشان يوصل للي المفروض يجاوبه.
// دلوقتي الطالب بيختار بنفسه، والسؤال بيوصل للمتخصص من غير وسيط.
//
// **زرار القايمة متشال مؤقتًا** بطلب صاحب المشروع، فالأوامر دي بتشتغل بالكتابة لحد ما يرجع.
// لما يرجع، الزرارين بيتضافوا في botManager.js من غير أي تعديل هنا.
//
// نفس ترتيب studentReport.js: الهاندلر ده **قبل message.js** عشان كلمة "سؤال علمي" ما تتسجّلش
// كرسالة واردة عند موظف المتابعة — هي أمر مش سؤال.

// التذكرة واحدة لكل جهة اتصال (قيد UNIQUE على contact_id)، فمفيش لبس في "أنهي تذكرة"
const TICKET_SQL = `
  SELECT t.id, t.transfer_team
  FROM tickets t JOIN contacts c ON c.id = t.contact_id
  WHERE c.chat_id = $1 LIMIT 1`;

// الرد بيتغيّر حسب سبب المنع — "مش هينفع" لوحدها بتخلي الطالب يعيد المحاولة من غير فايدة
function blockedReply(team, holderTeamKey) {
  if (holderTeamKey === team.key) {
    return `سؤالك مع ${team.label} بالفعل ${team.icon} — اكتبه وهيوصله.`;
  }
  if (holderTeamKey === 'whatsapp') {
    return 'فيه حد من الفريق بيكلمك دلوقتي 💬 كمّل معاه وهو هيوصّلك للي محتاجه.';
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
        return ctx.reply(`اكتب ${teamKey === 'science' ? 'سؤالك' : 'مشكلتك'} الأول وهوصّله لـ${team.label} على طول.`);
      }
      // **لاحظ:** المنع الحقيقي جوه performTransfer (transferGuard) تحت قفل الصف. الفحص هنا
      // عشان الرسالة تبقى مفهومة للطالب بس — مش عشان الحماية، والاتنين مش بديل لبعض.
      // التبديل بين العلمي والفني مسموح: الطالب سأل سؤال علمي وبعدين اتعطّل عنده حاجة تقنية
      if (ticket.transfer_team === team.key || ticket.transfer_team === 'whatsapp') {
        return ctx.reply(blockedReply(team, ticket.transfer_team));
      }

      // **require كسول عن قصد.** botManager بيحمّل الهاندلر ده وقت التشغيل، والكنترولر بيحمّل
      // botManager — فالاستيراد من فوق بيعمل دايرة بترجّع كائن نصّه فاضي، و`botManager.getBot`
      // بترمي TypeError وقت أول تحويل. الفحص النحوي مابيشوفش ده خالص.
      const { performTransfer } = require('../../controllers/teams.controller');
      const result = await performTransfer({ ticketId: ticket.id, teamKey, by: 'student' });

      // مفيش حد حاضر: performTransfer بعت رسالة الغياب للطالب بنفسه، فمنبعتش تانية فوقها
      if (!result.ok) {
        if (result.offline) return;
        return ctx.reply(blockedReply(team, result.team?.key));
      }

      return ctx.reply(
        `تمام ${team.icon} ${teamKey === 'science' ? 'سؤالك رايح للتيم العلمي' : 'مشكلتك رايحة للدعم الفني'}.\n`
        + `اكتب${teamKey === 'science' ? 'ه' : 'ها'} دلوقتي وهيرد عليك مباشرة.`
      );
    } catch (error) {
      console.error('❌ Failed to transfer a ticket at the student request:', error.message);
      return ctx.reply('حصلت مشكلة وإحنا بنحوّل طلبك. جرّب تاني بعد شوية.');
    }
  };

  bot.command('science', (ctx) => requestTeam(ctx, 'science'));
  bot.command('tech', (ctx) => requestTeam(ctx, 'tech'));

  // الكتابة بالعربي: الطالب اللي مش هيلاقي الزرار هيكتب. الأنماط **مقفولة على الجملة كاملة**
  // عشان "عندي سؤال علمي في الباب التالت" تفضل سؤال عادي يروح لموظف المتابعة، مش أمر تحويل
  bot.hears(/^\s*(سؤال\s*علمي|تيم\s*علمي|التيم\s*العلمي|🧪\s*سؤال\s*علمي)\s*$/i, (ctx) => requestTeam(ctx, 'science'));
  bot.hears(/^\s*(دعم\s*فني|مشكلة\s*تقنية|الدعم\s*الفني|🛠️?\s*دعم\s*فني)\s*$/i, (ctx) => requestTeam(ctx, 'tech'));
};
