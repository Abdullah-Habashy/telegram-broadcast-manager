const pool = require('../config/db');

async function listTemplates(req, res) {
  try {
    const result = await pool.query('SELECT * FROM templates ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في جلب القوالب' });
  }
}

async function createTemplate(req, res) {
  const { name, content } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: 'اسم القالب والمحتوى مطلوبين' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO templates (name, content) VALUES ($1, $2) RETURNING *',
      [name, content]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في إنشاء القالب' });
  }
}

async function deleteTemplate(req, res) {
  try {
    await pool.query('DELETE FROM templates WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'حصل خطأ في حذف القالب' });
  }
}

module.exports = { listTemplates, createTemplate, deleteTemplate };
