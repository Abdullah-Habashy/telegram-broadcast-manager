const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const botManager = require('../bot/botManager');

const VALID_STATUSES = ['new', 'in_progress', 'waiting_student', 'resolved', 'closed'];
const VALID_PRIORITIES = ['low', 'normal', 'urgent'];
const VALID_CATEGORIES = ['general', 'registration', 'fees', 'results', 'platform', 'complaint', 'technical'];

function removeUploadedImage(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

function buildTicketFilters(query) {
  const conditions = [];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.status && VALID_STATUSES.includes(query.status)) {
    conditions.push(`t.status = ${add(query.status)}`);
  }
  if (query.priority && VALID_PRIORITIES.includes(query.priority)) {
    conditions.push(`t.priority = ${add(query.priority)}`);
  }
  if (query.category && VALID_CATEGORIES.includes(query.category)) {
    conditions.push(`t.category = ${add(query.category)}`);
  }
  if (query.subtitle_id && /^\d+$/.test(query.subtitle_id)) {
    conditions.push(`t.subtitle_id = ${add(Number(query.subtitle_id))}`);
  }
  if (query.assigned_to === 'unassigned') {
    conditions.push('t.assigned_to IS NULL');
  } else if (query.assigned_to && /^\d+$/.test(query.assigned_to)) {
    conditions.push(`t.assigned_to = ${add(Number(query.assigned_to))}`);
  }
  if (query.unread === 'true') {
    conditions.push('t.unread_count > 0');
  }
  if (query.follow_up === 'due') {
    conditions.push("t.next_follow_up_at <= NOW() AND t.status NOT IN ('resolved', 'closed')");
  } else if (query.follow_up === 'today') {
    conditions.push(`(t.next_follow_up_at AT TIME ZONE 'Africa/Cairo')::date =
      (NOW() AT TIME ZONE 'Africa/Cairo')::date AND t.status NOT IN ('resolved', 'closed')`);
  } else if (query.follow_up === 'upcoming') {
    conditions.push("t.next_follow_up_at > NOW() AND t.status NOT IN ('resolved', 'closed')");
  } else if (query.follow_up === 'none') {
    conditions.push('t.next_follow_up_at IS NULL');
  }
  if (['1', '3', '7'].includes(query.sent_older_than)) {
    conditions.push(`EXISTS (
      SELECT 1 FROM support_messages sm WHERE sm.ticket_id = t.id
    ) AND NOT EXISTS (
      SELECT 1 FROM support_messages sm
      WHERE sm.ticket_id = t.id
        AND sm.sent_at >= NOW() - (${add(Number(query.sent_older_than))} * INTERVAL '1 day')
    )`);
  }
  if (['1', '3', '7'].includes(query.received_older_than)) {
    conditions.push(`EXISTS (
      SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id
    ) AND NOT EXISTS (
      SELECT 1 FROM incoming_messages im
      WHERE im.contact_id = c.id
        AND im.received_at >= NOW() - (${add(Number(query.received_older_than))} * INTERVAL '1 day')
    )`);
  }
  if (query.idea_number && /^\d+$/.test(query.idea_number)) {
    if (query.idea_number === '0') {
      conditions.push('t.current_idea_number IS NULL');
    } else {
      conditions.push(`t.current_idea_number = ${add(Number(query.idea_number))}`);
    }
  }
  if (query.q?.trim()) {
    const search = `%${query.q.trim()}%`;
    const placeholder = add(search);
    conditions.push(`(
      COALESCE(c.first_name, '') ILIKE ${placeholder}
      OR COALESCE(c.last_name, '') ILIKE ${placeholder}
      OR COALESCE(c.telegram_username, '') ILIKE ${placeholder}
      OR c.chat_id::text ILIKE ${placeholder}
      OR COALESCE(c.phone, '') ILIKE ${placeholder}
    )`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

async function listTickets(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const { where, params } = buildTicketFilters(req.query);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM tickets t JOIN contacts c ON c.id = t.contact_id ${where}`,
      params
    );
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT t.*, c.chat_id, c.telegram_username, c.first_name, c.last_name, c.phone,
        u.name AS assigned_name,
        ts.name AS subtitle_name,
        (SELECT MAX(sm.sent_at) FROM support_messages sm WHERE sm.ticket_id = t.id) AS last_sent_at,
        (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id) AS last_received_at,
        latest.content AS last_message_preview,
        latest.direction AS last_message_direction
       FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN ticket_subtitles ts ON ts.id = t.subtitle_id
       LEFT JOIN LATERAL (
         SELECT message.content, message.direction
         FROM (
           SELECT COALESCE(NULLIF(im.content, ''), CASE WHEN im.image_path IS NOT NULL THEN '📷 صورة' END) AS content,
             im.received_at AS occurred_at, 'incoming' AS direction
           FROM incoming_messages im WHERE im.contact_id = c.id
           UNION ALL
           SELECT COALESCE(NULLIF(sm.content, ''), CASE WHEN sm.image_path IS NOT NULL THEN '📷 صورة' END) AS content,
             sm.sent_at AS occurred_at, 'outgoing' AS direction
           FROM support_messages sm WHERE sm.ticket_id = t.id
         ) message
         ORDER BY message.occurred_at DESC
         LIMIT 1
       ) latest ON true
       ${where}
       ORDER BY t.last_message_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );

    const total = countResult.rows[0].count;
    res.json({ tickets: result.rows, page, pages: Math.max(1, Math.ceil(total / limit)), total });
  } catch (error) {
    console.error('❌ Failed to load tickets:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تحميل التذاكر' });
  }
}

async function getTicket(req, res) {
  const ticketId = Number(req.params.id);
  try {
    const ticketResult = await pool.query(
      `WITH updated AS (
         UPDATE tickets SET unread_count = 0 WHERE id = $1 RETURNING *
       )
       SELECT updated.*, c.chat_id, c.telegram_username, c.first_name, c.last_name, c.phone,
         ts.name AS subtitle_name
       FROM updated
       JOIN contacts c ON c.id = updated.contact_id
       LEFT JOIN ticket_subtitles ts ON ts.id = updated.subtitle_id`,
      [ticketId]
    );
    if (!ticketResult.rows[0]) return res.status(404).json({ error: 'التذكرة غير موجودة' });

    const messagesResult = await pool.query(
      `SELECT * FROM (
        SELECT 'incoming-' || im.id AS message_key, 'incoming' AS direction,
          im.content, im.received_at AS occurred_at, NULL::text AS sender_name, im.image_path
        FROM incoming_messages im
        JOIN tickets t ON t.contact_id = im.contact_id
        WHERE t.id = $1
        UNION ALL
        SELECT 'outgoing-' || sm.id AS message_key, 'outgoing' AS direction,
          sm.content, sm.sent_at AS occurred_at, u.name AS sender_name, sm.image_path
        FROM support_messages sm
        LEFT JOIN users u ON u.id = sm.sent_by
        WHERE sm.ticket_id = $1
      ) messages ORDER BY occurred_at ASC`,
      [ticketId]
    );

    res.json({ ticket: ticketResult.rows[0], messages: messagesResult.rows });
  } catch (error) {
    console.error('❌ Failed to load ticket:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تحميل المحادثة' });
  }
}

async function updateTicket(req, res) {
  const ticketId = Number(req.params.id);
  const updates = [];
  const params = [];
  const addUpdate = (column, value) => {
    params.push(value);
    updates.push(`${column} = $${params.length}`);
  };

  if (req.body.status !== undefined) {
    if (!VALID_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'حالة غير صالحة' });
    addUpdate('status', req.body.status);
  }
  if (req.body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(req.body.priority)) return res.status(400).json({ error: 'أولوية غير صالحة' });
    addUpdate('priority', req.body.priority);
  }
  if (req.body.category !== undefined) {
    if (!VALID_CATEGORIES.includes(req.body.category)) return res.status(400).json({ error: 'تصنيف غير صالح' });
    addUpdate('category', req.body.category);
  }
  if (req.body.subtitle_id !== undefined) {
    const subtitleId = Number(req.body.subtitle_id);
    if (!Number.isInteger(subtitleId) || subtitleId <= 0) {
      return res.status(400).json({ error: 'العنوان الفرعي غير صالح' });
    }
    addUpdate('subtitle_id', subtitleId);
  }
  if (req.body.assigned_to !== undefined) {
    const assignee = req.body.assigned_to === null || req.body.assigned_to === '' ? null : Number(req.body.assigned_to);
    if (assignee !== null && !Number.isInteger(assignee)) return res.status(400).json({ error: 'الموظف غير صالح' });
    addUpdate('assigned_to', assignee);
  }
  if (req.body.next_follow_up_at !== undefined) {
    if (req.body.next_follow_up_at === null || req.body.next_follow_up_at === '') {
      addUpdate('next_follow_up_at', null);
    } else {
      const followUpDate = new Date(req.body.next_follow_up_at);
      if (Number.isNaN(followUpDate.getTime())) return res.status(400).json({ error: 'موعد المتابعة غير صالح' });
      addUpdate('next_follow_up_at', followUpDate.toISOString());
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'لا توجد تعديلات' });

  params.push(ticketId);
  try {
    const result = await pool.query(
      `UPDATE tickets SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'التذكرة غير موجودة' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to update ticket:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تحديث التذكرة' });
  }
}

async function replyToTicket(req, res) {
  const ticketId = Number(req.params.id);
  const content = String(req.body.content || '').trim();
  if (!content && !req.file) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'اكتب نصًا أو أرفق صورة' });
  }
  if ((!req.file && content.length > 4096) || (req.file && content.length > 1024)) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: req.file ? 'النص مع الصورة يجب ألا يتجاوز 1024 حرفًا' : 'الرد أطول من الحد المسموح' });
  }

  const bot = botManager.getBot();
  if (!bot) {
    removeUploadedImage(req.file);
    return res.status(503).json({ error: 'البوت غير متصل حاليًا' });
  }

  let telegramSent = false;
  try {
    const ticketResult = await pool.query(
      `SELECT t.id, c.chat_id, u.name AS agent_name FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       JOIN users u ON u.id = $2 AND u.is_active = TRUE
       WHERE t.id = $1`,
      [ticketId, req.session.userId]
    );
    if (!ticketResult.rows[0]) {
      removeUploadedImage(req.file);
      return res.status(404).json({ error: 'التذكرة غير موجودة' });
    }

    const introSettingsResult = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('agent_intro_enabled', 'agent_intro_message')"
    );
    const introSettings = Object.fromEntries(introSettingsResult.rows.map((row) => [row.key, row.value]));
    if (introSettings.agent_intro_enabled === 'true' && introSettings.agent_intro_message) {
      const claimResult = await pool.query(
        `INSERT INTO agent_contact_introductions (ticket_id, user_id, introduction_date)
         VALUES ($1, $2, (NOW() AT TIME ZONE 'Africa/Cairo')::date)
         ON CONFLICT DO NOTHING
         RETURNING ticket_id`,
        [ticketId, req.session.userId]
      );

      if (claimResult.rows[0]) {
        const introText = introSettings.agent_intro_message
          .split('{name}')
          .join(ticketResult.rows[0].agent_name);
        try {
          const introTelegramMessage = await bot.telegram.sendMessage(ticketResult.rows[0].chat_id, introText);
          await pool.query(
            `INSERT INTO support_messages (ticket_id, sent_by, content, telegram_message_id)
             VALUES ($1, $2, $3, $4)`,
            [ticketId, req.session.userId, introText, introTelegramMessage.message_id]
          );
          await pool.query(
            `UPDATE tickets SET assigned_to = COALESCE(assigned_to, $2), updated_at = NOW()
             WHERE id = $1`,
            [ticketId, req.session.userId]
          );
        } catch (introError) {
          await pool.query(
            `DELETE FROM agent_contact_introductions
             WHERE ticket_id = $1 AND user_id = $2
               AND introduction_date = (NOW() AT TIME ZONE 'Africa/Cairo')::date`,
            [ticketId, req.session.userId]
          );
          throw introError;
        }
      }
    }

    const imagePath = req.file ? `uploads/support/${req.file.filename}` : null;
    const telegramMessage = req.file
      ? await bot.telegram.sendPhoto(
          ticketResult.rows[0].chat_id,
          { source: path.join(__dirname, '..', '..', 'public', imagePath) },
          content ? { caption: content } : {}
        )
      : await bot.telegram.sendMessage(ticketResult.rows[0].chat_id, content);
    telegramSent = true;
    const result = await pool.query(
      `INSERT INTO support_messages (ticket_id, sent_by, content, image_path, telegram_message_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ticketId, req.session.userId, content, imagePath, telegramMessage.message_id]
    );
    await pool.query(
      `UPDATE tickets SET
        status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END,
        assigned_to = COALESCE(assigned_to, $2),
        last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [ticketId, req.session.userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (!telegramSent) removeUploadedImage(req.file);
    console.error('❌ Failed to reply to ticket:', error.message);
    res.status(500).json({ error: 'فشل إرسال الرد إلى تيليجرام' });
  }
}

async function getTicketMeta(req, res) {
  try {
    const [users, subtitles, maxIdeaResult] = await Promise.all([
      pool.query('SELECT id, name FROM users WHERE is_active = TRUE ORDER BY name'),
      pool.query('SELECT id, name FROM ticket_subtitles ORDER BY name'),
      pool.query("SELECT value FROM settings WHERE key = 'max_idea_number'"),
    ]);
    const maxIdea = Number(maxIdeaResult.rows[0]?.value) || 20;
    res.json({
      users: users.rows,
      subtitles: subtitles.rows,
      statuses: VALID_STATUSES,
      priorities: VALID_PRIORITIES,
      categories: VALID_CATEGORIES,
      max_idea_number: maxIdea,
    });
  } catch (error) {
    res.status(500).json({ error: 'حصل خطأ في تحميل بيانات الدعم' });
  }
}

async function createTicketSubtitle(req, res) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اكتب العنوان الفرعي' });
  if (name.length > 80) return res.status(400).json({ error: 'العنوان الفرعي يجب ألا يتجاوز 80 حرفًا' });

  try {
    const result = await pool.query(
      `INSERT INTO ticket_subtitles (name, created_by)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [name, req.session.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to create ticket subtitle:', error.message);
    res.status(500).json({ error: 'حصل خطأ في إضافة العنوان الفرعي' });
  }
}

async function updateIdeaProgress(req, res) {
  const ticketId = Number(req.params.id);
  const ideaNumber = req.body.idea_number === null || req.body.idea_number === '' ? null : Number(req.body.idea_number);

  if (ideaNumber !== null) {
    if (!Number.isInteger(ideaNumber) || ideaNumber < 1 || ideaNumber > 999) {
      return res.status(400).json({ error: 'رقم الفكرة غير صالح' });
    }
    // التحقق من أن الرقم لا يتجاوز الحد المحدد في الإعدادات
    const maxResult = await pool.query("SELECT value FROM settings WHERE key = 'max_idea_number'");
    const maxIdea = Number(maxResult.rows[0]?.value) || 20;
    if (ideaNumber > maxIdea) {
      return res.status(400).json({ error: `رقم الفكرة يجب ألا يتجاوز ${maxIdea}` });
    }
  }

  try {
    const ticketResult = await pool.query(
      'UPDATE tickets SET current_idea_number = $1, updated_at = NOW() WHERE id = $2 RETURNING current_idea_number',
      [ideaNumber, ticketId]
    );
    if (!ticketResult.rows[0]) return res.status(404).json({ error: 'التذكرة غير موجودة' });

    if (ideaNumber !== null) {
      await pool.query(
        'INSERT INTO idea_progress_log (ticket_id, idea_number, changed_by) VALUES ($1, $2, $3)',
        [ticketId, ideaNumber, req.session.userId]
      );
    }

    res.json({ current_idea_number: ideaNumber });
  } catch (error) {
    console.error('❌ Failed to update idea progress:', error.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ رقم الفكرة' });
  }
}

async function getIdeaProgressLog(req, res) {
  const ticketId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT ipl.id, ipl.idea_number, ipl.changed_at, u.name AS changed_by_name
       FROM idea_progress_log ipl
       LEFT JOIN users u ON u.id = ipl.changed_by
       WHERE ipl.ticket_id = $1
       ORDER BY ipl.changed_at DESC
       LIMIT 10`,
      [ticketId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Failed to load idea progress log:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تحميل سجل الأفكار' });
  }
}

function streamEvents(req, res) {
  const events = require('../utils/events');
  events.registerClient(req, res);
}

module.exports = {
  listTickets, getTicket, updateTicket, replyToTicket, getTicketMeta,
  createTicketSubtitle, updateIdeaProgress, getIdeaProgressLog, streamEvents,
};
