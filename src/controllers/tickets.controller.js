const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const botManager = require('../bot/botManager');
const push = require('../utils/push');

const VALID_STATUSES = ['new', 'in_progress', 'waiting_student', 'resolved', 'closed'];
const VALID_PRIORITIES = ['low', 'normal', 'urgent'];
const VALID_CATEGORIES = ['general', 'registration', 'fees', 'results', 'platform', 'complaint', 'technical'];

// علامة الباب المشترك فيه الطالب (بجوار اسمه في قائمة التذاكر وجوه المحادثة) — القاعدة نفسها مشتركة
// في src/utils/bootcampMarks.js عشان تفضل نفسها في كل الشاشات. c.chat_id لازم يبقى متاح في الاستعلام.
const { BOOTCAMP_MARKS_SELECT_SQL } = require('../utils/bootcampMarks');
const BOOTCAMP_MARKS_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT ${BOOTCAMP_MARKS_SELECT_SQL}
    FROM tafra_students tstu
    JOIN tafra_enrollments te ON te.tafra_student_id = tstu.tafra_student_id AND te.enrollment_type = 'enroll'
    JOIN tafra_bootcamps tb ON tb.tafra_bootcamp_id = te.tafra_bootcamp_id
    WHERE tstu.telegram_chat_id = c.chat_id
  ) bootcamp_marks ON true
`;

function removeUploadedImage(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

// restrictToUserId: بيتحدد بس للموظف (مش الأدمن) — يقصر التذاكر الظاهرة له على المسندة له تحديدًا
// أو غير المسندة لحد، حتى لو حاول يتلاعب بفلتر assigned_to بنفسه (الشرطين بيتحدوا AND فمايقدرش يشوف
// تذاكر موظف تاني بأي شكل)
function buildTicketFilters(query, { restrictToUserId } = {}) {
  const conditions = [];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (restrictToUserId) {
    conditions.push(`(t.assigned_to = ${add(restrictToUserId)} OR t.assigned_to IS NULL)`);
  }

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
  // تذاكر مفتوحة (مش مكتملة/مغلقة) وآخر رسالة فيها واردة من الطالب — يعني لسه محتاجة رد، سواء
  // لسه ما اتردش عليها أصلًا أو الطالب بعت رسالة جديدة بعد آخر رد اتبعت له
  if (query.awaiting_reply === 'true') {
    conditions.push(`t.status NOT IN ('resolved', 'closed') AND (
      NOT EXISTS (SELECT 1 FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL)
      OR (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = t.contact_id) >
         (SELECT MAX(sm.sent_at) FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL)
    )`);
  }
  if (query.unassigned === 'true') {
    conditions.push('t.assigned_to IS NULL');
  }
  // لسه ما ردّ عليها موظف حقيقي ولا مرة (بنستبعد رسائل الإرسال الجماعي broadcast_recipient_id
  // ورسائل المتابعة التلقائية sent_by IS NULL، عشان دول مش "رد" فعلي من حد على كلام الطالب) —
  // أوسع من فلتر "مفتوحة ولم يُرد عليها" اللي بيشمل كمان اللي اترّد عليها قبل كده وبعدين الطالب بعت تاني
  if (query.never_replied === 'true') {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM support_messages sm
      WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL
        AND sm.sent_by IS NOT NULL AND sm.broadcast_recipient_id IS NULL
    )`);
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
      SELECT 1 FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM support_messages sm
      WHERE sm.ticket_id = t.id
        AND sm.deleted_at IS NULL
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
  // الموظف (مش الأدمن) يشوف بس التذاكر المسندة له أو غير المسندة لحد
  const restrictToUserId = req.session.userRole === 'admin' ? null : req.session.userId;
  const { where, params } = buildTicketFilters(req.query, { restrictToUserId });

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
        (SELECT MAX(sm.sent_at) FROM support_messages sm
          WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL) AS last_sent_at,
        (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id) AS last_received_at,
        latest.content AS last_message_preview,
        latest.direction AS last_message_direction,
        bootcamp_marks.in_chapter_one, bootcamp_marks.in_full_curriculum,
        (c.last_contacted_at IS NOT NULL) AS can_message
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
           FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL
         ) message
         ORDER BY message.occurred_at DESC
         LIMIT 1
       ) latest ON true
       ${BOOTCAMP_MARKS_JOIN_SQL}
       ${where}
       ORDER BY (t.unread_count > 0) DESC, t.last_message_at DESC
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

// كل معرّفات التذاكر المطابقة لنفس فلاتر شاشة صندوق الدعم بالظبط، بدون تقسيم صفحات وبنفس ترتيب
// العرض الافتراضي — عشان "تحديد أول عدد" يقدر ياخد أول N من إجمالي النتائج المطابقة مش بس الصفحة الحالية
async function listTicketIds(req, res) {
  const restrictToUserId = req.session.userRole === 'admin' ? null : req.session.userId;
  const { where, params } = buildTicketFilters(req.query, { restrictToUserId });
  try {
    const result = await pool.query(
      `SELECT t.id
       FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       ${where}
       ORDER BY (t.unread_count > 0) DESC, t.last_message_at DESC`,
      params
    );
    res.json({ ids: result.rows.map((row) => row.id) });
  } catch (error) {
    console.error('❌ Failed to list ticket ids:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة معرّفات التذاكر' });
  }
}

async function getTicket(req, res) {
  const ticketId = Number(req.params.id);
  try {
    // الموظف (مش الأدمن) ميقدرش يفتح تذكرة مسندة لموظف تاني، حتى لو حاول يدخل عليها بالـ id مباشرة
    if (req.session.userRole !== 'admin') {
      const assignmentCheck = await pool.query('SELECT assigned_to FROM tickets WHERE id = $1', [ticketId]);
      const assignedTo = assignmentCheck.rows[0]?.assigned_to;
      if (assignedTo !== null && assignedTo !== undefined && Number(assignedTo) !== Number(req.session.userId)) {
        return res.status(403).json({ error: 'التذكرة دي مسندة لموظف تاني' });
      }
    }

    const ticketResult = await pool.query(
      `WITH updated AS (
         UPDATE tickets SET unread_count = 0 WHERE id = $1 RETURNING *
       )
       SELECT updated.*, c.chat_id, c.telegram_username, c.first_name, c.last_name, c.phone,
         ts.name AS subtitle_name,
         bootcamp_marks.in_chapter_one, bootcamp_marks.in_full_curriculum,
         (c.last_contacted_at IS NOT NULL) AS can_message
       FROM updated
       JOIN contacts c ON c.id = updated.contact_id
       LEFT JOIN ticket_subtitles ts ON ts.id = updated.subtitle_id
       ${BOOTCAMP_MARKS_JOIN_SQL}`,
      [ticketId]
    );
    if (!ticketResult.rows[0]) return res.status(404).json({ error: 'التذكرة غير موجودة' });

    const messagesResult = await pool.query(
      `SELECT * FROM (
        SELECT 'incoming-' || im.id AS message_key, 'incoming' AS direction,
          im.content, im.received_at AS occurred_at, NULL::text AS sender_name, im.image_path,
          NULL::int AS message_id, NULL::int AS sent_by, NULL::timestamptz AS edited_at,
          im.id AS incoming_message_id, im.flag, im.agent_reaction,
          NULL::int AS reply_to_incoming_message_id, NULL::text AS reply_to_preview
        FROM incoming_messages im
        JOIN tickets t ON t.contact_id = im.contact_id
        WHERE t.id = $1
        UNION ALL
        SELECT 'outgoing-' || sm.id AS message_key, 'outgoing' AS direction,
          sm.content, sm.sent_at AS occurred_at, u.name AS sender_name, sm.image_path,
          sm.id AS message_id, sm.sent_by, sm.edited_at,
          NULL::int AS incoming_message_id, NULL::text AS flag, NULL::text AS agent_reaction,
          sm.reply_to_incoming_message_id,
          COALESCE(NULLIF(replied.content, ''), CASE WHEN replied.image_path IS NOT NULL THEN '📷 صورة' END) AS reply_to_preview
        FROM support_messages sm
        LEFT JOIN users u ON u.id = sm.sent_by
        LEFT JOIN incoming_messages replied ON replied.id = sm.reply_to_incoming_message_id
        WHERE sm.ticket_id = $1 AND sm.deleted_at IS NULL
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

    const newAssignee = result.rows[0].assigned_to;
    if (req.body.assigned_to !== undefined && newAssignee && Number(newAssignee) !== Number(req.session.userId)) {
      notifyTicketAssignment(ticketId, newAssignee).catch((err) =>
        console.error('❌ Failed to send assignment push notification:', err.message)
      );
    }
  } catch (error) {
    console.error('❌ Failed to update ticket:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تحديث التذكرة' });
  }
}

// إسناد مجموعة تذاكر لموظف واحد دفعة واحدة (أو إلغاء الإسناد لو assigned_to فاضي) — أدمن فقط
async function bulkAssignTickets(req, res) {
  const ticketIds = Array.isArray(req.body.ticket_ids)
    ? [...new Set(req.body.ticket_ids.map(Number).filter(Number.isInteger))]
    : [];
  const assignedTo = req.body.assigned_to === null || req.body.assigned_to === undefined || req.body.assigned_to === ''
    ? null
    : Number(req.body.assigned_to);

  if (!ticketIds.length) return res.status(400).json({ error: 'اختر تذكرة واحدة على الأقل' });
  if (assignedTo !== null && !Number.isInteger(assignedTo)) {
    return res.status(400).json({ error: 'اختر الموظف المسؤول' });
  }

  try {
    if (assignedTo !== null) {
      const userCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [assignedTo]);
      if (!userCheck.rows[0]) return res.status(400).json({ error: 'الموظف غير موجود أو غير مفعّل' });
    }

    const result = await pool.query(
      `UPDATE tickets SET assigned_to = $1, updated_at = NOW() WHERE id = ANY($2::int[]) RETURNING id`,
      [assignedTo, ticketIds]
    );
    res.json({ updated: result.rows.length });

    if (assignedTo !== null) {
      result.rows.forEach((row) => {
        notifyTicketAssignment(row.id, assignedTo).catch((err) =>
          console.error('❌ Failed to send bulk assignment push notification:', err.message)
        );
      });
    }
  } catch (error) {
    console.error('❌ Failed to bulk-assign tickets:', error.message);
    res.status(500).json({ error: 'حصل خطأ في إسناد التذاكر' });
  }
}

// إشعار الموظف على تليفونه لما يتحدد كمسؤول عن تذكرة، حتى لو المتصفح مقفول
async function notifyTicketAssignment(ticketId, userId) {
  if (!push.enabled) return;
  const result = await pool.query(
    `SELECT c.first_name, c.last_name, c.telegram_username
     FROM tickets t JOIN contacts c ON c.id = t.contact_id WHERE t.id = $1`,
    [ticketId]
  );
  const contact = result.rows[0];
  if (!contact) return;
  const studentName = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    || (contact.telegram_username ? `@${contact.telegram_username}` : 'طالب');

  await push.sendToUser(userId, {
    title: 'تم تعيينك على تذكرة',
    body: `تذكرة ${studentName} بقت مسؤوليتك دلوقتي`,
    tag: `ticket-${ticketId}`,
    url: `/?ticket=${ticketId}`,
  });
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
      `SELECT t.id, c.id AS contact_id, c.chat_id, u.name AS agent_name FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       JOIN users u ON u.id = $2 AND u.is_active = TRUE
       WHERE t.id = $1`,
      [ticketId, req.session.userId]
    );
    if (!ticketResult.rows[0]) {
      removeUploadedImage(req.file);
      return res.status(404).json({ error: 'التذكرة غير موجودة' });
    }

    // لو الموظف مختار يرد (quote) على رسالة معينة من الطالب — بنتأكد إنها فعلاً رسالة من نفس
    // الطالب صاحب التذكرة دي (مش رسالة طالب تاني) قبل ما نستخدم معرّفها في الرد
    let replyToIncomingMessageId = null;
    let replyToTelegramMessageId = null;
    const requestedReplyId = Number(req.body.reply_to_message_id);
    if (Number.isInteger(requestedReplyId) && requestedReplyId > 0) {
      const replyTargetResult = await pool.query(
        'SELECT id, telegram_message_id FROM incoming_messages WHERE id = $1 AND contact_id = $2',
        [requestedReplyId, ticketResult.rows[0].contact_id]
      );
      if (replyTargetResult.rows[0]?.telegram_message_id) {
        replyToIncomingMessageId = replyTargetResult.rows[0].id;
        replyToTelegramMessageId = replyTargetResult.rows[0].telegram_message_id;
      }
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

    // allow_sending_without_reply: لو الرسالة الأصلية اتمسحت من عند الطالب في الوقت ده بالذات، الرد
    // لسه يتبعت عادي (بدون quote) بدل ما العملية كلها تفشل
    const replyOptions = replyToTelegramMessageId
      ? { reply_parameters: { message_id: Number(replyToTelegramMessageId), allow_sending_without_reply: true } }
      : {};
    const imagePath = req.file ? `uploads/support/${req.file.filename}` : null;
    const telegramMessage = req.file
      ? await bot.telegram.sendPhoto(
          ticketResult.rows[0].chat_id,
          { source: path.join(__dirname, '..', '..', 'public', imagePath) },
          content ? { caption: content, ...replyOptions } : replyOptions
        )
      : await bot.telegram.sendMessage(ticketResult.rows[0].chat_id, content, replyOptions);
    telegramSent = true;
    const result = await pool.query(
      `INSERT INTO support_messages (ticket_id, sent_by, content, image_path, telegram_message_id, reply_to_incoming_message_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [ticketId, req.session.userId, content, imagePath, telegramMessage.message_id, replyToIncomingMessageId]
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

// يترجم أخطاء تيليجرام لرسائل مفهومة للموظف بدل النص الإنجليزي الخام
function telegramErrorMessage(error, fallback) {
  const description = error?.response?.description || error?.description || error?.message || '';
  if (/message is not modified/i.test(description)) return 'مفيش تغيير في محتوى الرسالة';
  if (/message to (edit|delete) not found|message identifier is not specified/i.test(description)) {
    return 'الرسالة مش موجودة في تيليجرام (يمكن تكون اتحذفت قبل كده)';
  }
  if (/message can'?t be (edited|deleted)|too old|TIME_EXPIRED/i.test(description)) {
    return 'تيليجرام مش بيسمح بالتعديل أو الحذف بعد مرور 48 ساعة على الرسالة';
  }
  return fallback;
}

// يجيب رسالة الموظف ويتأكد إن المستخدم الحالي له صلاحية التحكم فيها — نفس شرط صلاحية فتح التذكرة
// نفسها (الأدمن، أو الموظف المسند ليه، أو أي موظف لو لسه مش مسندة لحد)، مش بس رسائله هو. يعني
// موظف اتسندت له تذكرة يقدر يتحكم في أي رسالة جواها حتى لو مبعوتة تلقائيًا أو من موظف سابق
async function loadManageableMessage(messageId, userId) {
  const result = await pool.query(
    `SELECT sm.*, t.id AS ticket_id, t.assigned_to AS ticket_assigned_to, c.chat_id, viewer.role AS viewer_role
     FROM support_messages sm
     JOIN tickets t ON t.id = sm.ticket_id
     JOIN contacts c ON c.id = t.contact_id
     JOIN users viewer ON viewer.id = $2 AND viewer.is_active = TRUE
     WHERE sm.id = $1`,
    [messageId, userId]
  );
  const message = result.rows[0];
  if (!message || message.deleted_at) return { error: { status: 404, message: 'الرسالة غير موجودة' } };
  const assignedTo = message.ticket_assigned_to;
  const hasTicketAccess = message.viewer_role === 'admin'
    || assignedTo === null || Number(assignedTo) === Number(userId);
  if (!hasTicketAccess) {
    return { error: { status: 403, message: 'التذكرة دي مسندة لموظف تاني' } };
  }
  return { message };
}

async function editSupportMessage(req, res) {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'رقم الرسالة غير صالح' });

  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'اكتب نص الرسالة بعد التعديل' });

  try {
    const { message, error } = await loadManageableMessage(messageId, req.session.userId);
    if (error) return res.status(error.status).json({ error: error.message });

    const maxLength = message.image_path ? 1024 : 4096;
    if (content.length > maxLength) {
      return res.status(400).json({ error: `النص يجب ألا يتجاوز ${maxLength} حرفًا` });
    }
    if (!message.telegram_message_id) {
      return res.status(400).json({ error: 'الرسالة دي مش مرتبطة برسالة في تيليجرام فمش ممكن تعديلها' });
    }
    if (content === message.content) return res.json({ id: message.id, content, edited_at: message.edited_at });

    const bot = botManager.getBot();
    if (!bot) return res.status(503).json({ error: 'البوت غير متصل حاليًا' });

    try {
      if (message.image_path) {
        await bot.telegram.editMessageCaption(message.chat_id, Number(message.telegram_message_id), undefined, content);
      } else {
        await bot.telegram.editMessageText(message.chat_id, Number(message.telegram_message_id), undefined, content);
      }
    } catch (telegramError) {
      console.error('❌ Failed to edit Telegram message:', telegramError.message);
      return res.status(400).json({ error: telegramErrorMessage(telegramError, 'تعذر تعديل الرسالة في تيليجرام') });
    }

    const result = await pool.query(
      `UPDATE support_messages SET content = $2, edited_at = NOW(), edited_by = $3
       WHERE id = $1 RETURNING id, ticket_id, content, edited_at`,
      [messageId, content, req.session.userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to edit support message:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تعديل الرسالة' });
  }
}

async function deleteSupportMessage(req, res) {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'رقم الرسالة غير صالح' });

  try {
    const { message, error } = await loadManageableMessage(messageId, req.session.userId);
    if (error) return res.status(error.status).json({ error: error.message });

    let warning = null;
    if (message.telegram_message_id) {
      const bot = botManager.getBot();
      if (!bot) return res.status(503).json({ error: 'البوت غير متصل حاليًا' });
      try {
        await bot.telegram.deleteMessage(message.chat_id, Number(message.telegram_message_id));
      } catch (telegramError) {
        console.error('❌ Failed to delete Telegram message:', telegramError.message);
        warning = `اتشالت من اللوحة بس ${telegramErrorMessage(telegramError, 'تعذر حذفها من تيليجرام')}`;
      }
    } else {
      warning = 'اتشالت من اللوحة بس — مش مرتبطة برسالة في تيليجرام';
    }

    await pool.query(
      'UPDATE support_messages SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1',
      [messageId, req.session.userId]
    );
    res.json({ id: messageId, ticket_id: message.ticket_id, deleted: true, warning });
  } catch (error) {
    console.error('❌ Failed to delete support message:', error.message);
    res.status(500).json({ error: 'حصل خطأ في حذف الرسالة' });
  }
}

const VALID_FLAGS = ['star', 'complaint'];

// تمييز رسالة الطالب (star = رسالة حلوة/إشادة، complaint = شكوى) — أو إلغاء التمييز لو flag جه فاضي.
// أي حد يقدر يفتح التذكرة يقدر يميّز رسائلها، مش أدمن بس
async function flagIncomingMessage(req, res) {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'رقم الرسالة غير صالح' });
  const flag = req.body.flag === null || req.body.flag === undefined || req.body.flag === '' ? null : req.body.flag;
  if (flag !== null && !VALID_FLAGS.includes(flag)) return res.status(400).json({ error: 'تمييز غير صالح' });

  try {
    const result = await pool.query(
      `UPDATE incoming_messages im SET flag = $1
       FROM tickets t WHERE t.contact_id = im.contact_id AND im.id = $2
       RETURNING im.id, t.id AS ticket_id`,
      [flag, messageId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الرسالة غير موجودة' });
    res.json({ id: messageId, ticket_id: result.rows[0].ticket_id, flag });
  } catch (error) {
    console.error('❌ Failed to flag incoming message:', error.message);
    res.status(500).json({ error: 'تعذر تمييز الرسالة' });
  }
}

// مجموعة مختارة من الإيموجيز المسموح بيها فعليًا كـ reaction على تيليجرام (من قايمة تيليجرام الرسمية
// للبوتات) — مش أي إيموجي عشوائي، تيليجرام بترفض غيرها
const VALID_REACTIONS = ['👍', '❤', '🔥', '🎉', '😁', '🤔', '😢', '🙏'];

// حط/شيل reaction (إيموجي) على رسالة الطالب دي — حقيقي على تيليجرام نفسه عن طريق البوت،
// ومتزامن مع نسختنا المحلية عشان يفضل ظاهر حتى بعد Refresh
async function reactToIncomingMessage(req, res) {
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) return res.status(400).json({ error: 'رقم الرسالة غير صالح' });
  const emoji = req.body.emoji === null || req.body.emoji === undefined || req.body.emoji === '' ? null : req.body.emoji;
  if (emoji !== null && !VALID_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'إيموجي غير مدعوم' });

  const bot = botManager.getBot();
  if (!bot) return res.status(503).json({ error: 'البوت غير متصل حاليًا' });

  try {
    const result = await pool.query(
      `SELECT im.id, im.telegram_message_id, c.chat_id, t.id AS ticket_id
       FROM incoming_messages im
       JOIN contacts c ON c.id = im.contact_id
       JOIN tickets t ON t.contact_id = im.contact_id
       WHERE im.id = $1`,
      [messageId]
    );
    const message = result.rows[0];
    if (!message) return res.status(404).json({ error: 'الرسالة غير موجودة' });
    if (!message.telegram_message_id) {
      return res.status(400).json({ error: 'الرسالة دي قديمة ومش مرتبطة برسالة تيليجرام فمش ممكن نحط عليها reaction' });
    }

    try {
      await bot.telegram.setMessageReaction(
        message.chat_id,
        Number(message.telegram_message_id),
        emoji ? [{ type: 'emoji', emoji }] : []
      );
    } catch (telegramError) {
      console.error('❌ Failed to set Telegram message reaction:', telegramError.message);
      return res.status(400).json({ error: 'تعذر حط الـ reaction على تيليجرام' });
    }

    await pool.query('UPDATE incoming_messages SET agent_reaction = $1 WHERE id = $2', [emoji, messageId]);
    res.json({ id: messageId, ticket_id: message.ticket_id, agent_reaction: emoji });
  } catch (error) {
    console.error('❌ Failed to react to incoming message:', error.message);
    res.status(500).json({ error: 'تعذر التفاعل مع الرسالة' });
  }
}

// كل الرسائل المميّزة (رسائل حلوة أو شكاوى) من كل التذاكر مجمّعة في مكان واحد
async function listFlaggedMessages(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const flag = VALID_FLAGS.includes(req.query.flag) ? req.query.flag : null;

  const conditions = ['im.flag IS NOT NULL'];
  const params = [];
  if (flag) { params.push(flag); conditions.push(`im.flag = $${params.length}`); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM incoming_messages im ${where}`,
      params
    );
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT im.id, im.content, im.image_path, im.received_at, im.flag,
        t.id AS ticket_id, c.first_name, c.last_name, c.telegram_username, c.chat_id
       FROM incoming_messages im
       JOIN contacts c ON c.id = im.contact_id
       JOIN tickets t ON t.contact_id = im.contact_id
       ${where}
       ORDER BY im.received_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const total = countResult.rows[0].count;
    res.json({ messages: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('❌ Failed to load flagged messages:', error.message);
    res.status(500).json({ error: 'تعذر تحميل الرسائل المميّزة' });
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

// آخر N اختبار دخلهم الطالب فعليًا (بترتيب الأحدث أولًا) — لكتابة رسالة درجات جاهزة في الرد
async function getRecentExamMarks(req, res) {
  const ticketId = Number(req.params.id);
  const count = Math.min(20, Math.max(1, Number(req.query.count) || 5));
  try {
    const result = await pool.query(
      `SELECT te.name AS exam_name, tem.mark, tem.percentage, COALESCE(tem.taken_at, tem.updated_at) AS occurred_at
       FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       JOIN tafra_students ts ON ts.telegram_chat_id = c.chat_id
       JOIN tafra_exam_marks tem ON tem.tafra_student_id = ts.tafra_student_id
       JOIN tafra_exams te ON te.exam_type = tem.exam_type AND te.tafra_exam_id = tem.tafra_exam_id
       WHERE t.id = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [ticketId, count]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Failed to load recent exam marks:', error.message);
    res.status(500).json({ error: 'تعذر تحميل درجات آخر الاختبارات' });
  }
}

// كل درجات الطالب في اختبارات الكورسات اللي هو مشترك فيها فقط — مطابقة اسم الكورس بين
// tafra_bootcamps (اشتراكاته) و tafra_exams.bootcamp_name (اللي بيتحدد وقت مزامنة الاختبارات).
// متاح للاختبارات الأونلاين بس، لأن منصة طفرة نفسها مش بترجع اسم الكورس للاختبارات الورقية.
async function getCourseExamMarks(req, res) {
  const ticketId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT te.name AS exam_name, tem.mark, tem.percentage, te.bootcamp_name, COALESCE(tem.taken_at, tem.updated_at) AS occurred_at
       FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       JOIN tafra_students ts ON ts.telegram_chat_id = c.chat_id
       JOIN tafra_exam_marks tem ON tem.tafra_student_id = ts.tafra_student_id
       JOIN tafra_exams te ON te.exam_type = tem.exam_type AND te.tafra_exam_id = tem.tafra_exam_id
       WHERE t.id = $1
         AND te.bootcamp_name IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM tafra_enrollments en
           JOIN tafra_bootcamps tb ON tb.tafra_bootcamp_id = en.tafra_bootcamp_id
           WHERE en.tafra_student_id = ts.tafra_student_id
             AND en.enrollment_type = 'enroll'
             AND TRIM(tb.name) = TRIM(te.bootcamp_name)
         )
       ORDER BY te.bootcamp_name, occurred_at DESC`,
      [ticketId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Failed to load course exam marks:', error.message);
    res.status(500).json({ error: 'تعذر تحميل درجات اختبارات الكورسات المشترك فيها' });
  }
}

function streamEvents(req, res) {
  const events = require('../utils/events');
  events.registerClient(req, res);
}

module.exports = {
  listTickets, listTicketIds, getTicket, updateTicket, bulkAssignTickets, replyToTicket, getTicketMeta,
  editSupportMessage, deleteSupportMessage, getRecentExamMarks, getCourseExamMarks,
  createTicketSubtitle, updateIdeaProgress, getIdeaProgressLog, streamEvents,
  flagIncomingMessage, listFlaggedMessages, reactToIncomingMessage,
};
