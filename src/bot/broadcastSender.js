const pool = require('../config/db');
const path = require('path');
const botManager = require('./botManager');

// تأخير بسيط بين كل رسالة عشان نتجنب حدود معدل الإرسال بتاعة تليجرام
const DELAY_MS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBroadcast(broadcastId) {
  const bot = botManager.getBot();
  if (!bot) {
    console.error(`❌ Cannot send broadcast #${broadcastId}: no bot is connected (configure the token in Settings).`);
    await pool.query("UPDATE broadcasts SET status = 'failed' WHERE id = $1", [broadcastId]);
    return;
  }

  const broadcastResult = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [broadcastId]);
  const broadcast = broadcastResult.rows[0];
  if (!broadcast) return;

  await pool.query("UPDATE broadcasts SET status = 'sending' WHERE id = $1", [broadcastId]);

  const currentBotAudience = `(c.source <> 'tafra' OR EXISTS (
    SELECT 1 FROM incoming_messages source_message WHERE source_message.contact_id = c.id
  ))`;
  let contactsQuery = `SELECT c.* FROM contacts c WHERE ${currentBotAudience}`;
  let contactsParams = [];

  if (broadcast.selected_contact_ids?.length) {
    contactsQuery = `SELECT c.* FROM contacts c
      WHERE c.id = ANY($1::int[]) AND ${currentBotAudience} ORDER BY c.id`;
    contactsParams = [broadcast.selected_contact_ids];
  } else if (broadcast.filter_tag_id) {
    contactsQuery = `SELECT c.* FROM contacts c
      JOIN contact_tags ct ON ct.contact_id = c.id
      WHERE ct.tag_id = $1 AND ${currentBotAudience}`;
    contactsParams = [broadcast.filter_tag_id];
  }
  const contactsResult = await pool.query(contactsQuery, contactsParams);
  const contacts = contactsResult.rows;

  for (const contact of contacts) {
    const recipientRow = await pool.query(
      "INSERT INTO broadcast_recipients (broadcast_id, contact_id, status) VALUES ($1, $2, 'pending') RETURNING id",
      [broadcastId, contact.id]
    );
    const recipientId = recipientRow.rows[0].id;

    try {
      if (broadcast.image_path) {
        const imagePath = path.join(__dirname, '..', '..', 'public', broadcast.image_path);
        await bot.telegram.sendPhoto(
          contact.chat_id,
          { source: imagePath },
          { caption: broadcast.message_content }
        );
      } else {
        await bot.telegram.sendMessage(contact.chat_id, broadcast.message_content);
      }
      await pool.query(
        "UPDATE broadcast_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1",
        [recipientId]
      );
      await pool.query(
        `INSERT INTO support_messages
          (ticket_id, sent_by, content, image_path, broadcast_recipient_id, sent_at)
         SELECT t.id, $2, $3, $4, $5, NOW()
         FROM tickets t
         WHERE t.contact_id = $1
         ON CONFLICT DO NOTHING`,
        [contact.id, broadcast.created_by, broadcast.message_content, broadcast.image_path, recipientId]
      );
      await pool.query(
        `UPDATE tickets SET last_message_at = NOW(), updated_at = NOW()
         WHERE contact_id = $1`,
        [contact.id]
      );
      await pool.query('UPDATE contacts SET last_contacted_at = NOW() WHERE id = $1', [contact.id]);
    } catch (err) {
      await pool.query(
        "UPDATE broadcast_recipients SET status = 'failed', error_message = $2 WHERE id = $1",
        [recipientId, err.message]
      );
    }

    await sleep(DELAY_MS);
  }

  await pool.query("UPDATE broadcasts SET status = 'completed' WHERE id = $1", [broadcastId]);
  console.log(`✅ Broadcast #${broadcastId} completed for ${contacts.length} contact(s).`);
}

module.exports = { sendBroadcast };
