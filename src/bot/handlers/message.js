const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');
const push = require('../../utils/push');
const { getNextTicketAssignee } = require('../../utils/ticketAssignment');
const { isWithinWorkingHours, currentCairoTime } = require('../../utils/workingHours');

const incomingUploadDir = path.join(__dirname, '..', '..', '..', 'public', 'uploads', 'incoming');
fs.mkdirSync(incomingUploadDir, { recursive: true });

// لو التذكرة متعيّنة لموظف بنعلّمه بس، لو لسه بلا موظف بنعلّم كل الموظفين النشطين عشان حد ياخدها
async function notifyEmployeesOfIncomingMessage(ticket, { studentName, content, imagePath }) {
  if (!push.enabled || !ticket) return;

  let recipientIds;
  if (ticket.assigned_to) {
    recipientIds = [ticket.assigned_to];
  } else {
    const activeUsers = await pool.query('SELECT id FROM users WHERE is_active = TRUE');
    recipientIds = activeUsers.rows.map((row) => row.id);
  }
  if (!recipientIds.length) return;

  await push.sendToUsers(recipientIds, {
    title: `رسالة جديدة من ${studentName}`,
    body: content?.trim() ? content.trim().slice(0, 180) : (imagePath ? '📷 صورة' : ''),
    tag: `ticket-${ticket.id}`,
    url: `/?ticket=${ticket.id}`,
  });
}

function isOutsideWorkingHours(settings) {
  if (settings.working_hours_enabled !== 'true') return false;
  const start = settings.working_hours_start || '00:00';
  const end = settings.working_hours_end || '23:59';
  return !isWithinWorkingHours(start, end, currentCairoTime());
}

async function downloadTelegramPhoto(ctx, fileId) {
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Telegram file download returned ${response.status}`);
  const filename = `${crypto.randomUUID()}.jpg`;
  const absolutePath = path.join(incomingUploadDir, filename);
  fs.writeFileSync(absolutePath, Buffer.from(await response.arrayBuffer()));
  return { imagePath: `uploads/incoming/${filename}`, absolutePath };
}

async function processIncomingMessage(bot, ctx, { content, imagePath = null, absolutePath = null, fileId = null, telegramMessageId = null, replyToTelegramMessageId = null }) {
  const chatId = ctx.chat.id;
  const { username, first_name, last_name } = ctx.from;

  let imageStored = false;
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

    await pool.query(
      `INSERT INTO incoming_messages
         (contact_id, content, image_path, telegram_file_id, telegram_message_id, reply_to_telegram_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [contactId, content || '', imagePath, fileId, telegramMessageId, replyToTelegramMessageId]
    );
    imageStored = Boolean(imagePath);

    // لو دي تذكرة جديدة تمامًا (أول تواصل حقيقي مع الطالب ده)، لازم نجهّز رسالة الترحيب الموحدة زيها
    // زي بالظبط لو كان بدأ بـ /start — مش كل الطلاب بيبدأوا محادثتهم فعليًا بأمر /start (بعضهم بيكتب
    // رسالة عادي كأول تواصل)، فمينفعش رسالة الترحيب تتسجّل جوه هاندلر /start بس
    const welcomeSettingResult = await pool.query(
      "SELECT value FROM settings WHERE key = 'welcome_message_enabled'"
    );
    const welcomeEnabled = welcomeSettingResult.rows[0]?.value === 'true';

    // بنستخدم transaction هنا (مش UPSERT عادي) عشان نفرّق بدقة بين "تذكرة جديدة تمامًا" (تاخد دور
    // في توزيع صندوق الدعم بالتبادل، وتجهّز رسالة الترحيب لو مفعّلة) و"تذكرة موجودة بالفعل" (تتحدّث
    // بس، تفضل عند نفس الموظف المسند لها)
    const ticketClient = await pool.connect();
    let ticketRow;
    let isNewTicket = false;
    try {
      await ticketClient.query('BEGIN');
      const existingTicket = await ticketClient.query(
        'SELECT id FROM tickets WHERE contact_id = $1 FOR UPDATE',
        [contactId]
      );
      if (existingTicket.rows[0]) {
        const updateResult = await ticketClient.query(
          `UPDATE tickets SET
             status = CASE WHEN status = 'closed' THEN 'new' ELSE status END,
             unread_count = unread_count + 1,
             last_message_at = NOW(),
             updated_at = NOW()
           WHERE contact_id = $1
           RETURNING id, unread_count, assigned_to`,
          [contactId]
        );
        ticketRow = updateResult.rows[0];
      } else {
        isNewTicket = true;
        const nextAssignee = await getNextTicketAssignee(ticketClient);
        const insertResult = await ticketClient.query(
          `INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, updated_at, assigned_to)
           VALUES ($1, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'), 1, NOW(), NOW(), $2)
           RETURNING id, unread_count, assigned_to`,
          [contactId, nextAssignee]
        );
        ticketRow = insertResult.rows[0];

        if (welcomeEnabled) {
          // مفيش إرسال دلوقتي — بس بنسجّل في الطابور، وwelcomeMessageSender.js هو اللي هيبعت
          // فعليًا لما يدخل وقت العمل (حتى لو خارج الوقت المسموح دلوقتي بالظبط)
          await ticketClient.query(
            'INSERT INTO pending_welcome_sends (contact_id, ticket_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [contactId, ticketRow.id]
          );
        }
      }
      await ticketClient.query('COMMIT');
    } catch (error) {
      await ticketClient.query('ROLLBACK');
      throw error;
    } finally {
      ticketClient.release();
    }
    const ticketId = ticketRow?.id;
    const studentName = [first_name, last_name].filter(Boolean).join(' ') || (username ? `@${username}` : String(chatId));

    // إرسال إشعار فوري لجميع الموظفين المتصلين عبر SSE
    try {
      const events = require('../../utils/events');
      events.notifyNewIncomingMessage({
        ticket_id: ticketId,
        contact_id: contactId,
        student_name: studentName,
        chat_id: chatId,
        content: content || (imagePath ? '📷 صورة' : ''),
        image_path: imagePath,
        received_at: new Date().toISOString(),
      });
    } catch (eventErr) {
      console.error('❌ Failed to emit SSE event:', eventErr.message);
    }

    // إشعار على تليفون الموظف (Web Push) حتى لو المتصفح مقفول
    notifyEmployeesOfIncomingMessage(ticketRow, { studentName, content, imagePath }).catch((pushErr) =>
      console.error('❌ Failed to send push notification:', pushErr.message)
    );

    const settingsResult = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
        ('auto_reply_enabled', 'auto_reply_message', 'forwarding_enabled', 'forward_chat_id',
         'working_hours_enabled', 'working_hours_start', 'working_hours_end', 'outside_hours_reply_message')`
    );
    const settings = Object.fromEntries(settingsResult.rows.map((row) => [row.key, row.value]));

    if (
      settings.forwarding_enabled === 'true'
      && settings.forward_chat_id
      && String(chatId) !== settings.forward_chat_id
    ) {
      const senderName = [first_name, last_name].filter(Boolean).join(' ') || 'بدون اسم';
      const senderUsername = username ? `@${username}` : 'بدون username';
      const metadata = `📩 رسالة جديدة للبوت\nمن: ${senderName}\nالمستخدم: ${senderUsername}\nChat ID: ${chatId}`;

      try {
        if (imagePath) {
          const caption = `${metadata}${content ? `\n\n${content}` : ''}`.slice(0, 1024);
          await bot.telegram.sendPhoto(settings.forward_chat_id, { source: absolutePath }, { caption });
        } else {
          await bot.telegram.sendMessage(settings.forward_chat_id, `${metadata}\n\n${content}`);
        }
      } catch (forwardError) {
        console.error('❌ Failed to forward incoming message:', forwardError.message);
      }
    }

    // خارج مواعيد العمل بيطغى على الرد العادي — رسالة واحدة بس في كل مرة. لو التذكرة دي جديدة
    // ورسالة الترحيب مفعّلة، بلاش رد تاني هنا عشان الطالب مايستقبلش رسالتين مع بعض — رسالة
    // الترحيب هي اللي هتوصله من welcomeMessageSender.js
    // رد "خارج مواعيد العمل" مستقل عن رسالة الترحيب وله مفتاح تفعيل لوحده، فبنجرّبه لأي تذكرة
    // جديدة بغض النظر عن حالة الترحيب. بيرجع false لو مقفول أو لو دلوقتي جوه مواعيد العمل
    let ackSent = false;
    if (isNewTicket) {
      try {
        const { sendOutsideHoursAck } = require('../outsideHoursAck');
        ackSent = await sendOutsideHoursAck(ctx, {
          ticketId: ticketRow.id,
          contact: { first_name: ctx.from?.first_name, telegram_username: ctx.from?.username },
        });
      } catch (ackError) {
        console.error('❌ Failed to send the outside-hours acknowledgement on first message:', ackError.message);
      }
    }

    if (ackSent) {
      // الطالب استلم رد خارج المواعيد — أي رد إضافي هيبقى رسالتين ورا بعض
    } else if (isNewTicket && welcomeEnabled) {
      // رسالة الترحيب هي اللي هتوصله، فمفيش رد عادي هنا
    } else if (isOutsideWorkingHours(settings) && settings.outside_hours_reply_message) {
      try {
        const message = settings.outside_hours_reply_message
          .replaceAll('{start}', settings.working_hours_start || '')
          .replaceAll('{end}', settings.working_hours_end || '');
        await ctx.reply(message);
      } catch (replyError) {
        console.error('❌ Failed to send outside-hours reply:', replyError.message);
      }
    } else if (settings.auto_reply_enabled === 'true' && settings.auto_reply_message) {
      try {
        await ctx.reply(settings.auto_reply_message);
      } catch (replyError) {
        console.error('❌ Failed to send auto reply:', replyError.message);
      }
    }
  } catch (error) {
    if (absolutePath && !imageStored) fs.unlink(absolutePath, () => {});
    console.error('❌ Failed to process an incoming message:', error.message);
  }
}

function registerMessageHandler(bot) {
  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    await processIncomingMessage(bot, ctx, {
      content: ctx.message.text,
      telegramMessageId: ctx.message.message_id,
      // الطالب لما يعمل Reply، تليجرام بيبعت الرسالة الأصلية جوه التحديث — من غير ما نخزّنها
      // الموظف بيشوف "تمام" و"لأ" و"ده كام؟" من غير ما يعرف بترد على إيه
      replyToTelegramMessageId: ctx.message.reply_to_message?.message_id ?? null,
    });
  });

  bot.on('photo', async (ctx) => {
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];
    let downloaded = null;
    try {
      downloaded = await downloadTelegramPhoto(ctx, largestPhoto.file_id);
      await processIncomingMessage(bot, ctx, {
        content: ctx.message.caption || '',
        imagePath: downloaded.imagePath,
        absolutePath: downloaded.absolutePath,
        fileId: largestPhoto.file_id,
        telegramMessageId: ctx.message.message_id,
        replyToTelegramMessageId: ctx.message.reply_to_message?.message_id ?? null,
      });
    } catch (error) {
      if (downloaded?.absolutePath) fs.unlink(downloaded.absolutePath, () => {});
      console.error('❌ Failed to receive an incoming photo:', error.message);
      await ctx.reply('تعذر حفظ الصورة. حاول إرسالها مرة أخرى.');
    }
  });
}

module.exports = registerMessageHandler;
module.exports.notifyEmployeesOfIncomingMessage = notifyEmployeesOfIncomingMessage;
