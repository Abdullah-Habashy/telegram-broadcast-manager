const pool = require('../config/db');
const { TAFRA_NAME_JOIN_SQL, DISPLAY_NAME_SQL } = require('../utils/studentName');
const fs = require('fs');
const { sendBroadcast } = require('../bot/broadcastSender');

function removeUploadedImage(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

async function createBroadcast(req, res) {
  const { message_content, template_id, filter_tag_id, scheduled_for } = req.body;
  let selectedContactIds = req.body.selected_contact_ids;

  // زرار اختياري تحت الرسالة — لازم نص ورابط مع بعض أو ولا حاجة، والرابط لازم يبقى http(s) صحيح
  // عشان تليجرام يرفض أي reply_markup فيه رابط غير صالح ويفشل الإرسال كله
  const buttonText = String(req.body.button_text || '').trim() || null;
  const buttonUrl = String(req.body.button_url || '').trim() || null;
  if (buttonText && !buttonUrl) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'حطيت نص للزرار بدون رابط' });
  }
  if (buttonUrl && !/^https?:\/\//i.test(buttonUrl)) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'رابط الزرار لازم يبدأ بـ http:// أو https://' });
  }
  if (buttonText && buttonText.length > 64) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'نص الزرار طويل جدًا (64 حرف كحد أقصى)' });
  }

  const examMatch = /^(online|offline)-(\d+)$/.exec(String(req.body.exam || ''));
  const contextExamType = examMatch ? examMatch[1] : null;
  const contextExamId = examMatch ? Number(examMatch[2]) : null;

  if (typeof selectedContactIds === 'string') {
    try {
      selectedContactIds = JSON.parse(selectedContactIds);
    } catch (_) {
      removeUploadedImage(req.file);
      return res.status(400).json({ error: 'قائمة جهات الاتصال المحددة غير صالحة' });
    }
  }

  if (!message_content || !message_content.trim()) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'محتوى الرسالة مطلوب' });
  }

  if (req.file && message_content.trim().length > 1024) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'نص الرسالة مع الصورة يجب ألا يتجاوز 1024 حرفًا' });
  }

  const hasManualSelection = selectedContactIds !== undefined;
  if (hasManualSelection && (!Array.isArray(selectedContactIds) || selectedContactIds.length === 0)) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'اختار جهة اتصال واحدة على الأقل' });
  }

  const selectedIds = hasManualSelection
    ? [...new Set(selectedContactIds.map(Number).filter(Number.isInteger))]
    : null;

  if (hasManualSelection && selectedIds.length !== selectedContactIds.length) {
    removeUploadedImage(req.file);
    return res.status(400).json({ error: 'قائمة جهات الاتصال المحددة غير صالحة' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (selectedIds) {
      const contactsResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM contacts c
         WHERE id = ANY($1::int[])
           AND (c.source <> 'tafra' OR c.last_contacted_at IS NOT NULL)`,
        [selectedIds]
      );
      if (contactsResult.rows[0].count !== selectedIds.length) {
        await client.query('ROLLBACK');
        removeUploadedImage(req.file);
        return res.status(400).json({ error: 'واحدة أو أكثر من جهات الاتصال المحددة غير موجودة' });
      }
    }

    const result = await client.query(
      `INSERT INTO broadcasts
        (created_by, template_id, message_content, filter_tag_id, selected_contact_ids, image_path, scheduled_for,
         context_exam_type, context_exam_id, button_text, button_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        req.session.userId,
        template_id || null,
        message_content.trim(),
        selectedIds ? null : (filter_tag_id || null),
        selectedIds,
        req.file ? `uploads/${req.file.filename}` : null,
        scheduled_for || null,
        contextExamType,
        contextExamId,
        buttonText,
        buttonUrl,
      ]
    );
    const broadcast = result.rows[0];
    await client.query('COMMIT');

    if (!scheduled_for) {
      // إرسال فوري — الطلب بيرجع فورًا، والإرسال الفعلي بيكمل في الخلفية
      sendBroadcast(broadcast.id).catch((err) => console.error('❌ Immediate broadcast failed:', err.message));
    }

    res.json(broadcast);
  } catch (err) {
    await client.query('ROLLBACK');
    removeUploadedImage(req.file);
    console.error('❌ Failed to create broadcast:', err.message);
    res.status(500).json({ error: 'حصل خطأ في إنشاء عملية الإرسال' });
  } finally {
    client.release();
  }
}

async function listBroadcasts(req, res) {
  try {
    const result = await pool.query(`
      SELECT b.*,
        COUNT(br.id) FILTER (WHERE br.status = 'sent')::int AS sent_count,
        COUNT(br.id) FILTER (WHERE br.status = 'failed')::int AS failed_count,
        COUNT(br.id)::int AS total_count
      FROM broadcasts b
      LEFT JOIN broadcast_recipients br ON br.broadcast_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Failed to load broadcast history:', err.message);
    res.status(500).json({ error: 'حصل خطأ في جلب سجل الإرسال' });
  }
}

async function getBroadcast(req, res) {
  try {
    const broadcastResult = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [req.params.id]);
    if (broadcastResult.rows.length === 0) {
      return res.status(404).json({ error: 'مش موجود' });
    }
    const recipientsResult = await pool.query(
      `SELECT br.*, c.chat_id, c.first_name, c.last_name, c.telegram_username,
              tafra_match.name AS tafra_name, ${DISPLAY_NAME_SQL} AS display_name
       FROM broadcast_recipients br
       JOIN contacts c ON c.id = br.contact_id
       ${TAFRA_NAME_JOIN_SQL}
       WHERE br.broadcast_id = $1
       ORDER BY br.id`,
      [req.params.id]
    );
    res.json({ ...broadcastResult.rows[0], recipients: recipientsResult.rows });
  } catch (err) {
    console.error('❌ Failed to load broadcast details:', err.message);
    res.status(500).json({ error: 'حصل خطأ في جلب تفاصيل عملية الإرسال' });
  }
}

module.exports = { createBroadcast, listBroadcasts, getBroadcast };
