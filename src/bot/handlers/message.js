const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');

const incomingUploadDir = path.join(__dirname, '..', '..', '..', 'public', 'uploads', 'incoming');
fs.mkdirSync(incomingUploadDir, { recursive: true });

async function downloadTelegramPhoto(ctx, fileId) {
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Telegram file download returned ${response.status}`);
  const filename = `${crypto.randomUUID()}.jpg`;
  const absolutePath = path.join(incomingUploadDir, filename);
  fs.writeFileSync(absolutePath, Buffer.from(await response.arrayBuffer()));
  return { imagePath: `uploads/incoming/${filename}`, absolutePath };
}

async function processIncomingMessage(bot, ctx, { content, imagePath = null, absolutePath = null, fileId = null }) {
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
      'INSERT INTO incoming_messages (contact_id, content, image_path, telegram_file_id) VALUES ($1, $2, $3, $4)',
      [contactId, content || '', imagePath, fileId]
    );
    imageStored = Boolean(imagePath);

    const ticketResult = await pool.query(
      `INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, updated_at)
       VALUES ($1, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'), 1, NOW(), NOW())
       ON CONFLICT (contact_id) DO UPDATE SET
         status = CASE WHEN tickets.status = 'closed' THEN 'new' ELSE tickets.status END,
         unread_count = tickets.unread_count + 1,
         last_message_at = NOW(),
         updated_at = NOW()
       RETURNING id, unread_count`,
      [contactId]
    );
    const ticketId = ticketResult.rows[0]?.id;

    // إرسال إشعار فوري لجميع الموظفين المتصلين عبر SSE
    try {
      const events = require('../../utils/events');
      const studentName = [first_name, last_name].filter(Boolean).join(' ') || (username ? `@${username}` : String(chatId));
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

    const settingsResult = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
        ('auto_reply_enabled', 'auto_reply_message', 'forwarding_enabled', 'forward_chat_id')`
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

    if (settings.auto_reply_enabled === 'true' && settings.auto_reply_message) {
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

module.exports = function registerMessageHandler(bot) {
  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    await processIncomingMessage(bot, ctx, { content: ctx.message.text });
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
      });
    } catch (error) {
      if (downloaded?.absolutePath) fs.unlink(downloaded.absolutePath, () => {});
      console.error('❌ Failed to receive an incoming photo:', error.message);
      await ctx.reply('تعذر حفظ الصورة. حاول إرسالها مرة أخرى.');
    }
  });
};
