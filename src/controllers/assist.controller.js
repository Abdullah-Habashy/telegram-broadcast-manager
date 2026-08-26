const pool = require('../config/db');
const aiReply = require('../utils/aiReply');
const aiHarvest = require('../utils/aiHarvest');
const aiMining = require('../utils/aiMining');

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
    res.json({ knowledge: rows, ai_available: aiReply.isEnabled(), providers: aiReply.listProviders() });
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
// بيشغّل السؤال على **كل** مزوّد متاح ويرجّع النتايج جنب بعض. المقارنة على نفس السؤال هي
// الطريقة الوحيدة للحكم إذا كان المجاني يكفي — وأهم أسئلة الاختبار هي اللي **مش** في المصدر
async function testKnowledge(req, res) {
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'اكتب سؤال للتجربة' });
  if (!aiReply.isEnabled()) {
    return res.status(503).json({ error: 'مفيش أي مفتاح مضبوط على السيرفر — لا Claude ولا Groq' });
  }
  try {
    res.json(await aiReply.compareProviders({ question }));
  } catch (error) {
    console.error('❌ AI test failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// إعدادات الرد الآلي. مفاتيح محددة بالاسم مش أي مفتاح بيتبعت — فتح جدول الإعدادات كله
// للكتابة كان هيخلّي أي خطأ في الواجهة يقدر يكتب فوق توكن البوت أو مواعيد العمل
const AI_SETTING_KEYS = ['ai_reply_enabled', 'ai_provider', 'ai_reply_prefix',
  'ai_blocked_topics', 'ai_general_instructions'];

async function updateAiSettings(req, res) {
  const entries = Object.entries(req.body || {}).filter(([key]) => AI_SETTING_KEYS.includes(key));
  if (!entries.length) return res.status(400).json({ error: 'مفيش إعدادات صالحة' });
  try {
    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to update AI settings:', error.message);
    res.status(500).json({ error: 'تعذر حفظ الإعدادات' });
  }
}

// ===== المساحة التجريبية: محادثة + حصاد =====

// محادثة بنفس قواعد الرد على الطالب بالظبط — الغرض إن الأدمن يشوف اللي الطالب هيشوفه.
// كل دور بيرجّع النتيجة (رد / مش لاقي / ممنوع) عشان الثغرة تبان لحظتها، والأدمن يكتب
// الإجابة الصح في الرسالة اللي بعدها فتتحصد في الآخر
async function chat(req, res) {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  const last = messages.filter((m) => m.role === 'user').slice(-1)[0];
  if (!last?.content) return res.status(400).json({ error: 'مفيش رسالة' });
  try {
    const result = await aiReply.generateReply({
      question: String(last.content).trim(),
      provider: req.body.provider,
      skipEnabledCheck: true,
    });
    res.json(result);
  } catch (error) {
    console.error('❌ AI chat failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// بيقرا المحادثة ويقترح إضافات وتصحيحات. **مابيكتبش** — الاقتراحات بتترد للمراجعة
async function harvestChat(req, res) {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (messages.length < 2) return res.status(400).json({ error: 'المحادثة قصيرة أوي على الحصاد' });
  try {
    const changes = await aiHarvest.harvestFromMessages({
      messages,
      providerKey: req.body.provider || 'anthropic',
    });
    res.json({ changes });
  } catch (error) {
    console.error('❌ Harvest failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// رفع ملف نصي وتحويله لأسئلة وإجابات. نفس القاعدة: اقتراحات للمراجعة مش كتابة مباشرة
async function harvestFile(req, res) {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'الملف فاضي أو مش نص' });
  if (text.length > 60000) return res.status(400).json({ error: 'الملف كبير أوي — قسّمه لأجزاء' });
  try {
    const changes = await aiHarvest.harvestFromText({
      text, providerKey: req.body.provider || 'anthropic',
    });
    res.json({ changes });
  } catch (error) {
    console.error('❌ File harvest failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// تطبيق اللي الأدمن وافق عليه. الاقتراحات بتتبعت من المتصفح تاني بعد التعديل، فبتتحقق هنا
// من أول وجديد — الثقة في اللي جاي من الواجهة مش في محلها لما الموضوع مصدر معلومات
async function applyChanges(req, res) {
  const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
  const clean = changes
    .filter((c) => c && String(c.question || '').trim() && String(c.answer || '').trim())
    .map((c) => ({
      action: c.action === 'update' && Number(c.target_id) ? 'update' : 'add',
      target_id: Number(c.target_id) || null,
      question: String(c.question).trim(),
      answer: String(c.answer).trim(),
    }));
  if (!clean.length) return res.status(400).json({ error: 'مفيش اقتراحات صالحة' });
  try {
    const result = await aiHarvest.applyChanges(clean, req.body.source === 'file' ? 'file' : 'chat');
    res.json(result);
  } catch (error) {
    console.error('❌ Failed to apply knowledge changes:', error.message);
    res.status(500).json({ error: 'تعذر حفظ التعديلات' });
  }
}

// استخراج من المحادثات اللي حصلت فعلًا. الفلتر تكرار الرد: اللي الموظف كتبه مرات كتير هو
// سؤال شائع بالتعريف، واللي اتكتب مرة حالة خاصة. من غير الفلتر ده كان لازم نبعت آلاف
// الأزواج للنموذج ونستقبل مخرج أغلبه دردشة
async function mineHistory(req, res) {
  const minRepeats = Math.max(2, Math.min(50, Number(req.body.min_repeats) || aiMining.DEFAULT_MIN_REPEATS));
  try {
    const result = await aiMining.mineFromHistory({
      providerKey: req.body.provider || 'anthropic',
      minRepeats,
    });
    res.json({ ...result, min_repeats: minRepeats });
  } catch (error) {
    console.error('❌ Mining failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// معاينة الردود المتكررة من غير أي نداء للنموذج — عشان الأدمن يشوف الخام ويظبط حد التكرار
async function previewClusters(req, res) {
  const minRepeats = Math.max(2, Math.min(50, Number(req.query.min_repeats) || aiMining.DEFAULT_MIN_REPEATS));
  try {
    const clusters = await aiMining.findClusters({ minRepeats });
    res.json({ clusters, min_repeats: minRepeats });
  } catch (error) {
    console.error('❌ Failed to preview clusters:', error.message);
    res.status(500).json({ error: 'تعذر قراءة الردود المتكررة' });
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
  updateAiSettings, chat, harvestChat, harvestFile, applyChanges, mineHistory, previewClusters,
};
