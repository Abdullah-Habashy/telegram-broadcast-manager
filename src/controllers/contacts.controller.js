const pool = require('../config/db');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const VALID_STATUSES = ['new', 'in_progress', 'waiting_student', 'resolved', 'closed'];
const VALID_PRIORITIES = ['low', 'normal', 'urgent'];
const VALID_CATEGORIES = ['general', 'registration', 'fees', 'results', 'platform', 'complaint', 'technical'];
const LAST_SENT_SQL = `(SELECT MAX(outgoing.sent_at) FROM (
  SELECT br.sent_at FROM broadcast_recipients br
  WHERE br.contact_id = c.id AND br.status = 'sent'
  UNION ALL
  SELECT sm.sent_at FROM support_messages sm
  JOIN tickets support_ticket ON support_ticket.id = sm.ticket_id
  WHERE support_ticket.contact_id = c.id
) outgoing)`;

function parseChatId(value) {
  const normalized = String(value ?? '').trim()
    .replace(/^="(-?\d+)"$/, '$1')
    .replace(/^'(-?\d+)$/, '$1');
  if (!/^-?\d+$/.test(normalized)) return null;
  const chatId = Number(normalized);
  return Number.isSafeInteger(chatId) && chatId !== 0 ? chatId : null;
}

function excelTextNumber(value) {
  return `="${String(value)}"`;
}

function formatExportDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// GET /api/contacts?sent_older_than=1|3|7|never&received_older_than=1|3|7|never&tag=3
// فلتران مستقلان لآخر رسالة ناجحة أرسلناها وآخر رسالة استلمناها من المستخدم.
async function listContacts(req, res) {
  const { sent_older_than, received_older_than, tag } = req.query;
  const params = [];
  // طلاب طفرة الذين لم يراسلوا البوت الحالي يظلون في صفحة طلاب المنصة فقط.
  const conditions = [
    `(c.source <> 'tafra' OR EXISTS (
      SELECT 1 FROM incoming_messages source_message WHERE source_message.contact_id = c.id
    ))`,
  ];

  if (sent_older_than === 'never') {
    conditions.push(`${LAST_SENT_SQL} IS NULL`);
  } else if (['1', '3', '7'].includes(sent_older_than)) {
    params.push(Number(sent_older_than));
    conditions.push(`${LAST_SENT_SQL} < NOW() - ($${params.length} * INTERVAL '1 day')`);
  }

  if (received_older_than === 'never') {
    conditions.push('NOT EXISTS (SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id)');
  } else if (['1', '3', '7'].includes(received_older_than)) {
    params.push(Number(received_older_than));
    conditions.push(`EXISTS (SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id)
      AND NOT EXISTS (
        SELECT 1 FROM incoming_messages im
        WHERE im.contact_id = c.id
          AND im.received_at >= NOW() - ($${params.length} * INTERVAL '1 day')
      )`);
  }
  if (tag) {
    params.push(tag);
    conditions.push(`c.id IN (SELECT contact_id FROM contact_tags WHERE tag_id = $${params.length})`);
  }
  if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (req.query.priority && VALID_PRIORITIES.includes(req.query.priority)) {
    params.push(req.query.priority);
    conditions.push(`t.priority = $${params.length}`);
  }
  if (req.query.category && VALID_CATEGORIES.includes(req.query.category)) {
    params.push(req.query.category);
    conditions.push(`t.category = $${params.length}`);
  }
  if (req.query.subtitle_id && /^\d+$/.test(req.query.subtitle_id)) {
    params.push(Number(req.query.subtitle_id));
    conditions.push(`t.subtitle_id = $${params.length}`);
  }
  if (req.query.assigned_to === 'unassigned') {
    conditions.push('t.id IS NOT NULL AND t.assigned_to IS NULL');
  } else if (req.query.assigned_to && /^\d+$/.test(req.query.assigned_to)) {
    params.push(Number(req.query.assigned_to));
    conditions.push(`t.assigned_to = $${params.length}`);
  }
  if (req.query.unread === 'true') conditions.push('t.unread_count > 0');
  if (req.query.follow_up === 'due') {
    conditions.push("t.next_follow_up_at <= NOW() AND t.status NOT IN ('resolved', 'closed')");
  } else if (req.query.follow_up === 'today') {
    conditions.push(`(t.next_follow_up_at AT TIME ZONE 'Africa/Cairo')::date =
      (NOW() AT TIME ZONE 'Africa/Cairo')::date AND t.status NOT IN ('resolved', 'closed')`);
  } else if (req.query.follow_up === 'upcoming') {
    conditions.push("t.next_follow_up_at > NOW() AND t.status NOT IN ('resolved', 'closed')");
  } else if (req.query.follow_up === 'none') {
    conditions.push('t.id IS NOT NULL AND t.next_follow_up_at IS NULL');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT c.*,
      ${LAST_SENT_SQL} AS last_sent_at,
      (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id) AS last_received_at,
      t.status AS ticket_status, t.priority AS ticket_priority, t.category AS ticket_category,
      t.assigned_to, t.unread_count, t.next_follow_up_at,
      ts.name AS subtitle_name, u.name AS assigned_name,
      COALESCE((
        SELECT json_agg(json_build_object('id', tag_item.id, 'name', tag_item.name, 'color', tag_item.color))
        FROM contact_tags contact_tag
        JOIN tags tag_item ON tag_item.id = contact_tag.tag_id
        WHERE contact_tag.contact_id = c.id
      ), '[]') AS tags
    FROM contacts c
    LEFT JOIN tickets t ON t.contact_id = c.id
    LEFT JOIN ticket_subtitles ts ON ts.id = t.subtitle_id
    LEFT JOIN users u ON u.id = t.assigned_to
    ${where}
    ORDER BY c.created_at DESC
  `;

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to load contacts:', err.message);
    res.status(500).json({ error: 'حصل خطأ في جلب جهات الاتصال' });
  }
}

// POST /api/contacts/import  (multipart/form-data, حقل الملف اسمه "file")
// الملف لازم يحتوي عمود chat_id إلزامي — راجع الملحوظة الفنية في المواصفات
async function importContacts(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'من فضلك ارفع ملف CSV' });
  }

  let records;
  try {
    records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'ملف CSV غير صالح: ' + err.message });
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'الملف فاضي' });
  }
  if (!('chat_id' in records[0])) {
    return res.status(400).json({
      error: 'الملف لازم يحتوي عمود chat_id — تليجرام مايسمحش بإرسال رسائل لأرقام موبايل مباشرة، لازم chat_id فعلي من تفاعل سابق مع البوت',
    });
  }

  const client = await pool.connect();
  let imported = 0;
  let skipped = 0;
  const errors = [];

  try {
    await client.query('BEGIN');
    for (const [index, row] of records.entries()) {
      const chatId = parseChatId(row.chat_id);
      if (chatId === null) {
        skipped++;
        errors.push(`صف ${index + 2}: chat_id غير صالح`);
        continue;
      }
      await client.query(
        `INSERT INTO contacts (chat_id, telegram_username, first_name, last_name, phone, source)
         VALUES ($1, $2, $3, $4, $5, 'csv_import')
         ON CONFLICT (chat_id) DO UPDATE SET
           telegram_username = COALESCE(EXCLUDED.telegram_username, contacts.telegram_username),
           first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
           last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
           phone = COALESCE(EXCLUDED.phone, contacts.phone)`,
        [chatId, row.username || null, row.first_name || row.name || null, row.last_name || null, row.phone || null]
      );
      imported++;
    }
    await client.query('COMMIT');
    res.json({ imported, skipped, errors: errors.slice(0, 20) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to import contacts from CSV:', err.message);
    res.status(500).json({ error: 'حصل خطأ أثناء الاستيراد، اترجعش خطوة والملف اتحفظ' });
  } finally {
    client.release();
  }
}

// GET /api/contacts/export
async function exportContacts(req, res) {
  try {
    const result = await pool.query(
      `SELECT chat_id, telegram_username AS username, first_name, last_name, phone,
              source, last_contacted_at, created_at
       FROM contacts ORDER BY created_at DESC`
    );
    const excelRows = result.rows.map((row) => ({
      ...row,
      chat_id: excelTextNumber(row.chat_id),
      last_contacted_at: formatExportDate(row.last_contacted_at),
      created_at: formatExportDate(row.created_at),
    }));
    // UTF-8 BOM يجعل Excel يتعرف على العربية، وchat_id يُصدّر كنص لمنع Scientific notation.
    const csv = '\uFEFF' + stringify(excelRows, { header: true });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Failed to export contacts:', err.message);
    res.status(500).json({ error: 'حصل خطأ في التصدير' });
  }
}

// GET /api/tags
async function listTags(req, res) {
  try {
    const result = await pool.query('SELECT * FROM tags ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في جلب التصنيفات' });
  }
}

// POST /api/tags  { name, color }
async function createTag(req, res) {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم التصنيف مطلوب' });
  try {
    const result = await pool.query(
      'INSERT INTO tags (name, color) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING *',
      [name, color || '#6b7280']
    );
    res.json(result.rows[0] || { message: 'التصنيف موجود بالفعل' });
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في إنشاء التصنيف' });
  }
}

// POST /api/contacts/:id/tags  { tagId }
async function assignTag(req, res) {
  const { id } = req.params;
  const { tagId } = req.body;
  try {
    await pool.query(
      'INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, tagId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في ربط التصنيف' });
  }
}

// DELETE /api/contacts/:id/tags/:tagId
async function removeTag(req, res) {
  const { id, tagId } = req.params;
  try {
    await pool.query('DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2', [id, tagId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في إزالة التصنيف' });
  }
}

module.exports = {
  listContacts,
  importContacts,
  exportContacts,
  listTags,
  createTag,
  assignTag,
  removeTag,
};
