const pool = require('../../config/db');
const { getNextTicketAssignee } = require('../../utils/ticketAssignment');
const { notifyEmployeesOfIncomingMessage } = require('./message');

// عند /start: تسجيل تلقائي لجهة الاتصال (أو تحديث بياناتها لو كانت مسجّلة قبل كده). لو أول مرة
// مطلقًا يضغط فيها الطالب Start (يعني أول تواصل بيننا وبينه على الإطلاق)، بننشئله تذكرة فورًا
// وناخد له دور في التوزيع بالتبادل على موظفي صندوق الدعم (ده مش مرتبط بوقت العمل، بيحصل فورًا).
// رسالة الترحيب الموحدة (لو مفعّلة) بس هي اللي بتستنى وقت العمل — بتتسجّل في طابور
// pending_welcome_sends وبيبعتها welcomeMessageSender.js لما يدخل الوقت المسموح
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
         RETURNING id, (xmax = 0) AS is_new_contact`,
        [chatId, username || null, first_name || null, last_name || null]
      );
      const contactId = contactResult.rows[0].id;
      const isNewContact = contactResult.rows[0].is_new_contact;

      if (!isNewContact) {
        await ctx.reply('أهلاً بيك تاني! ✅');
        return;
      }

      const settingsResult = await pool.query(
        "SELECT value FROM settings WHERE key = 'welcome_message_enabled'"
      );
      const welcomeEnabled = settingsResult.rows[0]?.value === 'true';

      const client = await pool.connect();
      let ticketId;
      let assignedTo;
      try {
        await client.query('BEGIN');
        const nextAssignee = await getNextTicketAssignee(client);
        const insertResult = await client.query(
          `INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, updated_at, assigned_to)
           VALUES ($1, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'), 0, NOW(), NOW(), $2)
           RETURNING id, assigned_to`,
          [contactId, nextAssignee]
        );
        ticketId = insertResult.rows[0].id;
        assignedTo = insertResult.rows[0].assigned_to;

        if (welcomeEnabled) {
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

      if (!welcomeEnabled) {
        // السلوك القديم — رد فوري بسيط لحد ما حد يفعّل رسالة الترحيب الموحدة من الإعدادات
        const messageText = 'أهلاً بيك! ✅ تم تسجيلك بنجاح.';
        const telegramMessage = await ctx.reply(messageText);
        await pool.query(
          `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id)
           VALUES ($1, NULL, $2, $3)`,
          [ticketId, messageText, telegramMessage.message_id]
        );

        const studentName = [first_name, last_name].filter(Boolean).join(' ') || (username ? `@${username}` : String(chatId));
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
