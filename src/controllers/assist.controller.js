const pool = require('../config/db');
const aiReply = require('../utils/aiReply');

// ---------- الردود الجاهزة وقاعدة معرفة الرد الآلي ----------
//
// الاتنين في متحكّم واحد لأنهم نفس الفكرة من ناحيتين: نصوص محفوظة بيتعاد استخدامها. الفرق إن
// الردود الجاهزة بيستعملها الموظف بإيده، وقاعدة المعرفة بيستعملها النموذج لما مفيش موظف.

// ===== الردود الجاهزة =====

async function listQuickReplies(req, res) {
  try {
    // الموظف بيشوف المفعّل بس؛ الأدمن بيشوف الكل عشان يقدر يرجّع المعطّل
    const { rows } = await pool.query(
      req.session.userRole === 'admin'
        ? 'SELECT * FROM quick_replies ORDER BY sort_order, id'
        : 'SELECT * FROM quick_replies WHERE is_active ORDER BY sort_order, id'
    );
    res.json({ quick_replies: rows });
  } catch (error) {
    console.error('❌ Failed to list quick replies:', error.message);
    res.status(500).json({ error: 'تعذر تحميل الردود الجاهزة' });
  }
}

async function createQuickReply(req, res) {
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  if (!title || !content) return res.status(400).json({ error: 'العنوان والنص مطلوبين' });
  if (content.length > 4096) return res.status(400).json({ error: 'النص أطول من حد تليجرام' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO quick_replies (title, content, sort_order)
       VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM quick_replies), 0))
       RETURNING *`,
      [title, content]
    );
    res.json(rows[0]);
  } catch (error) {
    console.error('❌ Failed to create a quick reply:', error.message);
    res.status(500).json({ error: 'تعذر إضافة الرد الجاهز' });
  }
}

async function updateQuickReply(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'الرد غير صالح' });
  const updates = [];
  const params = [];
  const add = (column, value) => { params.push(value); updates.push(`${column} = $${params.length}`); };
  if (req.body.title !== undefined) add('title', String(req.body.title).trim());
  if (req.body.content !== undefined) add('content', String(req.body.content).trim());
  if (req.body.is_active !== undefined) add('is_active', Boolean(req.body.is_active));
  if (req.body.sort_order !== undefined) add('sort_order', Number(req.body.sort_order) || 0);
  if (!updates.length) return res.status(400).json({ error: 'لا توجد تعديلات' });
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE quick_replies SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows[0]) return res.status(404).json({ error: 'الرد غير موجود' });
    res.json(rows[0]);
  } catch (error) {
    console.error('❌ Failed to update a quick reply:', error.message);
    res.status(500).json({ error: 'تعذر تعديل الرد الجاهز' });
  }
}

async function deleteQuickReply(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'الرد غير صالح' });
  try {
    await pool.query('DELETE FROM quick_replies WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete a quick reply:', error.message);
    res.status(500).json({ error: 'تعذر حذف الرد الجاهز' });
  }
}

// ===== قاعدة المعرفة =====

async function listKnowledge(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM ai_knowledge ORDER BY id');
    res.json({ knowledge: rows, ai_available: aiReply.isEnabled(), model: aiReply.MODEL });
  } catch (error) {
    console.error('❌ Failed to list the knowledge base:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قاعدة المعرفة' });
  }
}

async function createKnowledge(req, res) {
  const question = String(req.body.question || '').trim();
  const answer = String(req.body.answer || '').trim();
  if (!question || !answer) return res.status(400).json({ error: 'السؤال والإجابة مطلوبين' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO ai_knowledge (question, answer) VALUES ($1, $2) RETURNING *', [question, answer]
    );
    res.json(rows[0]);
  } catch (error) {
    console.error('❌ Failed to add knowledge:', error.message);
    res.status(500).json({ error: 'تعذر إضافة المعلومة' });
  }
}

async function updateKnowledge(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'المعلومة غير صالحة' });
  const updates = [];
  const params = [];
  const add = (column, value) => { params.push(value); updates.push(`${column} = $${params.length}`); };
  if (req.body.question !== undefined) add('question', String(req.body.question).trim());
  if (req.body.answer !== undefined) add('answer', String(req.body.answer).trim());
  if (req.body.is_active !== undefined) add('is_active', Boolean(req.body.is_active));
  if (!updates.length) return res.status(400).json({ error: 'لا توجد تعديلات' });
  updates.push('updated_at = NOW()');
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE ai_knowledge SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows[0]) return res.status(404).json({ error: 'المعلومة غير موجودة' });
    res.json(rows[0]);
  } catch (error) {
    console.error('❌ Failed to update knowledge:', error.message);
    res.status(500).json({ error: 'تعذر تعديل المعلومة' });
  }
}

async function deleteKnowledge(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'المعلومة غير صالحة' });
  try {
    await pool.query('DELETE FROM ai_knowledge WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete knowledge:', error.message);
    res.status(500).json({ error: 'تعذر حذف المعلومة' });
  }
}

// تجربة سؤال من اللوحة قبل ما الطلاب يشوفوا الرد. **مابيبعتش حاجة لحد** — الغرض إن الأدمن
// يشوف بنفسه النموذج بيرد بإيه، ويكتشف الثغرات في قاعدة المعرفة قبل ما يشغّل الميزة
async function testKnowledge(req, res) {
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'اكتب سؤال للتجربة' });
  if (!aiReply.isEnabled()) return res.status(503).json({ error: 'مفتاح Claude مش مضبوط على السيرفر' });
  try {
    const result = await aiReply.generateReply({ question });
    res.json(result);
  } catch (error) {
    console.error('❌ AI test failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// سجل الردود الآلية — الأدمن بيراجع منه إيه اللي اتقال، وإيه اللي النموذج ملقاهوش
// (الصفوف دي بالذات هي قايمة الشغل: كل واحد فيها معلومة ناقصة من قاعدة المعرفة)
async function getAiLog(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, COALESCE(s.name, c.first_name) AS student_name
       FROM ai_reply_log l
       LEFT JOIN tickets t ON t.id = l.ticket_id
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN LATERAL (SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1) s ON true
       ORDER BY l.created_at DESC LIMIT 200`
    );
    const summary = await pool.query(
      `SELECT outcome, COUNT(*)::int AS count FROM ai_reply_log
       WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY outcome`
    );
    res.json({ log: rows, summary: rows.length ? summary.rows : [] });
  } catch (error) {
    console.error('❌ Failed to load the AI reply log:', error.message);
    res.status(500).json({ error: 'تعذر تحميل سجل الردود الآلية' });
  }
}

module.exports = {
  listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply,
  listKnowledge, createKnowledge, updateKnowledge, deleteKnowledge, testKnowledge, getAiLog,
};
