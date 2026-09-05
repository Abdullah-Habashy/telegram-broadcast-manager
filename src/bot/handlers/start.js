const pool = require('../../config/db');
const { displayName, platformNameFor } = require('../../utils/studentName');
const { getNextTicketAssignee } = require('../../utils/ticketAssignment');
const { notifyEmployeesOfIncomingMessage } = require('./message');
const { sendOutsideHoursAck } = require('../outsideHoursAck');
const { STUDENT_MENU_OPTIONS } = require('../studentMenu');

// عند /start: تسجيل تلقائي لجهة الاتصال (أو تحديث بياناتها لو كانت مسجّلة قبل كده). "أول مرة
// مطلقًا" بيتحدد بوجود تذكرة من عدمه (مش بوجود صف جهة الاتصال) — لأن طلاب منصة طفرة عندهم صف
// contacts جاهز أصلاً من المزامنة (source='tafra') حتى لو أول مرة يتكلموا مع البوت فعليًا، فالاعتماد
// على "صف جديد" كان بيفوّت رسالة الترحيب والتذكرة الجديدة لأي طالب زي ده. لو التذكرة جديدة فعلًا،
// بناخده دور في التوزيع بالتبادل على موظفي صندوق الدعم فورًا (ده مش مرتبط بوقت العمل). رسالة الترحيب
// الموحدة (لو مفعّلة) بس هي اللي بتستنى وقت العمل — بتتسجّل في طابور pending_welcome_sends
// وبيبعتها welcomeMessageSender.js لما يدخل الوقت المسموح
module.exports = function registerStartHandler(bot) {
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const { username, first_name, last_name } = ctx.from;

    try {
      const contactResult = await pool.query(
        `INSERT INTO contacts (chat_id, telegram_username, first_name, last_name, source, last_contacted_at)
         VALUES ($1, $2, $3, $4, 'bot', NOW())
         ON CONFLICT (chat_id) DO UPDATE SET
           telegram_username = EXCLUDED.telegram_username,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           last_contacted_at = NOW()
         RETURNING id`,
        [chatId, username || null, first_name || null, last_name || null]
      );
      const contactId = contactResult.rows[0].id;

      const settingsResult = await pool.query(
        "SELECT value FROM settings WHERE key = 'welcome_message_enabled'"
      );
      const welcomeEnabled = settingsResult.rows[0]?.value === 'true';

      const client = await pool.connect();
      let ticketId;
      let assignedTo;
      let isNewTicket = false;
      try {
        await client.query('BEGIN');
        const existingTicket = await client.query(
          'SELECT id, assigned_to FROM tickets WHERE contact_id = $1 FOR UPDATE',
          [contactId]
        );
        if (existingTicket.rows[0]) {
          ticketId = existingTicket.rows[0].id;
          assignedTo = existingTicket.rows[0].assigned_to;
        } else {
          isNewTicket = true;
          const nextAssignee = await getNextTicketAssignee(client);
          const insertResult = await client.query(
            `INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, updated_at, assigned_to)
             VALUES ($1, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'), 0, NOW(), NOW(), $2)
             RETURNING id, assigned_to`,
            [contactId, nextAssignee]
          );
          ticketId = insertResult.rows[0].id;
          assignedTo = insertResult.rows[0].assigned_to;
        }

        if (isNewTicket && welcomeEnabled) {
          // مفيش إرسال دلوقتي — بس بنسجّل في الطابور، وwelcomeMessageSender.js هو اللي هيبعت
          // فعليًا لما يدخل وقت العمل (حتى لو خارج الوقت المسموح دلوقتي بالظبط)
          await client.query(
            'INSERT INTO pending_welcome_sends (contact_id, ticket_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [contactId, ticketId]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      if (!isNewTicket) {
        await ctx.reply('أهلاً بيك تاني! ✅', STUDENT_MENU_OPTIONS);
        return;
      }

      // رد "خارج مواعيد العمل" مستقل تمامًا عن رسالة الترحيب — كل واحد له مفتاح تفعيل ونص لوحده،
      // فينفع تشغّل أي واحد فيهم بدون التاني. الدالة نفسها هي اللي بتقرر: بترجع false لو مقفول
      // أو لو دلوقتي جوه مواعيد العمل، و true لو بعتت فعلاً
      let ackSent = false;
      try {
        ackSent = await sendOutsideHoursAck(ctx, {
          ticketId,
          contact: { first_name, telegram_username: username },
        });
      } catch (ackError) {
        console.error('❌ Failed to send the outside-hours acknowledgement on /start:', ackError.message);
      }

      // الرد البسيط القديم بيشتغل بس لو مفيش أي رد تاني وصل للطالب: لا ترحيب مفعّل (وقتها الترحيب
      // هو اللي هيوصله) ولا رد خارج المواعيد اتبعت (وقتها الطالب استلم رسالة أوضح منه أصلاً)
      if (!welcomeEnabled && !ackSent) {
        // السلوك القديم — رد فوري بسيط لحد ما حد يفعّل رسالة الترحيب الموحدة من الإعدادات
        const messageText = 'أهلاً بيك! ✅ تم تسجيلك بنجاح.';
        const telegramMessage = await ctx.reply(messageText, STUDENT_MENU_OPTIONS);
        await pool.query(
          `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id, is_welcome)
           VALUES ($1, NULL, $2, $3, TRUE)`,
          [ticketId, messageText, telegramMessage.message_id]
        );

        const platformName = await platformNameFor(chatId);
        const studentName = displayName({
          tafra_name: platformName, first_name, last_name, telegram_username: username, chat_id: chatId,
        });
        try {
          const events = require('../../utils/events');
          events.notifyNewIncomingMessage({
            ticket_id: ticketId, contact_id: contactId, student_name: studentName, chat_id: chatId,
            content: messageText, image_path: null, received_at: new Date().toISOString(),
          });
        } catch (eventErr) {
          console.error('❌ Failed to emit SSE event for new Start ticket:', eventErr.message);
        }

        notifyEmployeesOfIncomingMessage({ id: ticketId, assigned_to: assignedTo }, { studentName, content: messageText }).catch(
          (pushErr) => console.error('❌ Failed to send push notification for new Start ticket:', pushErr.message)
        );
      }
    } catch (err) {
      console.error('❌ Failed to register a contact through /start:', err.message);
      await ctx.reply('حصل خطأ بسيط، جرب تاني كمان شوية 🙏');
    }
  });
};
