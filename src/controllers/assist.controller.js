const pool = require('../config/db');
const aiReply = require('../utils/aiReply');
const aiHarvest = require('../utils/aiHarvest');
const aiMining = require('../utils/aiMining');
const aiTraining = require('../utils/aiTraining');

// ---------- الردود الجاهزة وقاعدة معرفة الرد الآلي ----------
//
// الاتنين في متحكّم واحد لأنهم نفس الفكرة من ناحيتين: نصوص محفوظة بيتعاد استخدامها. الفرق إن
// الردود الجاهزة بيستعملها الموظف بإيده، وقاعدة المعرفة بيستعملها النموذج لما مفيش موظف.

// ===== الردود الجاهزة =====

async function listQuickReplies(req, res) {
  try {
    // الأدمن بيشوف الكل (بما فيه المعطّل عشان يقدر يرجّعه)؛ الموظف بيشوف العام + بتاعه هو.
    // is_mine بيترجع عشان الواجهة تعرف تعرض زراير التعديل والحذف على بتوعه بس
    const { rows } = await pool.query(
      req.session.userRole === 'admin'
        ? `SELECT q.*, (q.user_id IS NOT NULL) AS is_mine, u.name AS owner_name
           FROM quick_replies q LEFT JOIN users u ON u.id = q.user_id
           ORDER BY q.user_id NULLS FIRST, q.sort_order, q.id`
        : `SELECT q.*, (q.user_id = $1) AS is_mine, NULL::text AS owner_name
           FROM quick_replies q
           WHERE q.is_active AND (q.user_id IS NULL OR q.user_id = $1)
           ORDER BY q.user_id NULLS FIRST, q.sort_order, q.id`,
      req.session.userRole === 'admin' ? [] : [req.session.userId]
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
    // الأدمن بيضيف رد عام للفريق كله، والموظف بيضيف رد شخصي ليه هو
    const ownerId = req.session.userRole === 'admin' ? null : req.session.userId;
    const { rows } = await pool.query(
      `INSERT INTO quick_replies (title, content, user_id, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM quick_replies), 0))
       RETURNING *`,
      [title, content, ownerId]
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
  // الموظف بيعدّل في ردوده الشخصية بس — الشرط في الاستعلام نفسه مش فحص قبله، عشان
  // مايبقاش فيه فجوة بين التحقق والتنفيذ
  let ownerGuard = '';
  if (req.session.userRole !== 'admin') {
    params.push(req.session.userId);
    ownerGuard = ` AND user_id = $${params.length}`;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE quick_replies SET ${updates.join(', ')}
       WHERE id = $${params.length - (ownerGuard ? 1 : 0)}${ownerGuard} RETURNING *`, params
    );
    if (!rows[0]) return res.status(404).json({ error: 'الرد مش موجود أو مش بتاعك' });
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
    const result = req.session.userRole === 'admin'
      ? await pool.query('DELETE FROM quick_replies WHERE id = $1 RETURNING id', [id])
      : await pool.query('DELETE FROM quick_replies WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, req.session.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'الرد مش موجود أو مش بتاعك' });
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

// ===== قايمة التعليمات =====
//
// التعليمات كانت نص واحد في `settings.ai_general_instructions`، والخانة دي **لسه شغّالة**.
// القايمة دي فوقها: كل تعليمة صف تقدر تعطّله أو تحذفه لوحده لما يطلع إنه بيضر — وده اللي
// النص الواحد ما كانش بيسمح بيه. `aiReply.joinInstructions` بيجمع الاتنين
async function listInstructions(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS author_name
       FROM ai_instructions i LEFT JOIN users u ON u.id = i.created_by
       ORDER BY i.id`
    );
    res.json({ instructions: rows });
  } catch (error) {
    console.error('❌ Failed to list AI instructions:', error.message);
    res.status(500).json({ error: 'تعذر تحميل التعليمات' });
  }
}

async function createInstruction(req, res) {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'اكتب التعليمة' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_instructions (content, source, created_by) VALUES ($1, $2, $3)
       RETURNING *`,
      [content, req.body.source === 'training' ? 'training' : 'manual', req.session.userId]
    );
    res.status(201).json({ instruction: rows[0] });
  } catch (error) {
    console.error('❌ Failed to create an AI instruction:', error.message);
    res.status(500).json({ error: 'تعذر حفظ التعليمة' });
  }
}

async function updateInstruction(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'التعليمة غير صالحة' });
  const fields = [];
  const values = [id];
  if (req.body.content !== undefined) {
    const content = String(req.body.content).trim();
    if (!content) return res.status(400).json({ error: 'التعليمة مش ممكن تبقى فاضية' });
    values.push(content);
    fields.push(`content = $${values.length}`);
  }
  if (req.body.is_active !== undefined) {
    values.push(Boolean(req.body.is_active));
    fields.push(`is_active = $${values.length}`);
  }
  if (!fields.length) return res.status(400).json({ error: 'مفيش حاجة تتحدّث' });
  try {
    const { rows } = await pool.query(
      `UPDATE ai_instructions SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, values
    );
    if (!rows[0]) return res.status(404).json({ error: 'التعليمة غير موجودة' });
    res.json({ instruction: rows[0] });
  } catch (error) {
    console.error('❌ Failed to update an AI instruction:', error.message);
    res.status(500).json({ error: 'تعذر تعديل التعليمة' });
  }
}

async function deleteInstruction(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'التعليمة غير صالحة' });
  try {
    await pool.query('DELETE FROM ai_instructions WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete an AI instruction:', error.message);
    res.status(500).json({ error: 'تعذر حذف التعليمة' });
  }
}

// ===== مساحة التدريب على شات قديم =====

// بحث عن محادثة للتجربة. الترتيب بعدد رسايل الطالب مش بالتاريخ: المحادثة اللي فيها ٣٠ سؤال
// بتدي جلسة تدريب حقيقية، واللي فيها "شكرًا" بس مابتعلّمش حاجة
async function searchTrainingTickets(req, res) {
  const term = String(req.query.q || '').trim();
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.created_at,
         COALESCE(s.name, c.first_name, c.telegram_username, c.chat_id::text) AS student_name,
         (SELECT COUNT(*)::int FROM incoming_messages im
           WHERE im.contact_id = c.id
             AND LENGTH(TRIM(COALESCE(im.content, ''))) >= ${aiTraining.MIN_QUESTION_LENGTH}
             AND im.content !~ '${aiTraining.MEDIA_PLACEHOLDER_PATTERN}') AS question_count
       FROM tickets t
       JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN LATERAL (
         SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
       ) s ON true
       WHERE ($1 = '' OR COALESCE(s.name, c.first_name, c.telegram_username, '') ILIKE '%' || $1 || '%'
              OR t.id::text = $1)
       ORDER BY question_count DESC, t.id DESC
       LIMIT 25`,
      [term]
    );
    res.json({ tickets: rows.filter((row) => row.question_count > 0) });
  } catch (error) {
    console.error('❌ Failed to search training tickets:', error.message);
    res.status(500).json({ error: 'تعذر البحث عن المحادثات' });
  }
}

async function startTraining(req, res) {
  const ticketId = Number(req.body.ticket_id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'اختار محادثة الأول' });
  if (!aiReply.isEnabled()) {
    return res.status(503).json({ error: 'مفيش أي مفتاح مضبوط على السيرفر — لا Claude ولا Groq' });
  }
  try {
    const result = await aiTraining.runTraining({
      ticketId,
      provider: req.body.provider || undefined,
      userId: req.session.userId,
      limit: req.body.limit,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (error) {
    console.error('❌ AI training run failed:', error.message);
    res.status(500).json({ error: error.message });
  }
}

// جلسة واحدة بكل بنودها — عشان الأدمن يقفل الصفحة ويرجع يكمّل تقييم بعدين
async function getTrainingRun(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'الجلسة غير صالحة' });
  try {
    const run = await pool.query(
      `SELECT r.*, COALESCE(s.name, c.first_name, c.telegram_username) AS student_name
       FROM ai_training_runs r
       LEFT JOIN tickets t ON t.id = r.ticket_id
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN LATERAL (SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1) s ON true
       WHERE r.id = $1`,
      [id]
    );
    if (!run.rows[0]) return res.status(404).json({ error: 'الجلسة غير موجودة' });
    const items = await pool.query(
      'SELECT * FROM ai_training_items WHERE run_id = $1 ORDER BY position', [id]
    );
    res.json({ run: run.rows[0], items: items.rows });
  } catch (error) {
    console.error('❌ Failed to load a training run:', error.message);
    res.status(500).json({ error: 'تعذر تحميل الجلسة' });
  }
}

async function listTrainingRuns(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.ticket_id, r.provider, r.created_at,
         COALESCE(s.name, c.first_name, c.telegram_username) AS student_name,
         COUNT(i.id)::int AS total,
         COUNT(*) FILTER (WHERE i.verdict = 'good')::int AS good,
         COUNT(*) FILTER (WHERE i.verdict = 'bad')::int AS bad
       FROM ai_training_runs r
       LEFT JOIN ai_training_items i ON i.run_id = r.id
       LEFT JOIN tickets t ON t.id = r.ticket_id
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN LATERAL (SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1) s ON true
       GROUP BY r.id, s.name, c.first_name, c.telegram_username
       ORDER BY r.created_at DESC LIMIT 30`
    );
    res.json({ runs: rows });
  } catch (error) {
    console.error('❌ Failed to list training runs:', error.message);
    res.status(500).json({ error: 'تعذر تحميل الجلسات' });
  }
}

// التقييم + التعليمة في نداء واحد: الاتنين فعل واحد عند الأدمن ("الرد ده وحش **لأنه**...")،
// وفصلهم كان معناه تقييم يتحفظ وتعليمة تضيع لو النداء التاني فشل
async function reviewTrainingItem(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'البند غير صالح' });
  const verdict = req.body.verdict === 'good' || req.body.verdict === 'bad' ? req.body.verdict : null;
  const note = String(req.body.note || '').trim();
  // التعليمة بتتضاف للقايمة وبتأثر على أي تشغيل بعد كده. الملاحظة من غير الخانة دي بتتسجّل
  // على البند بس — مش كل ملاحظة تستاهل تبقى قاعدة دايمة
  const asInstruction = Boolean(req.body.as_instruction) && note;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let instructionId = null;
    if (asInstruction) {
      const inserted = await client.query(
        `INSERT INTO ai_instructions (content, source, created_by) VALUES ($1, 'training', $2)
         RETURNING id`,
        [note, req.session.userId]
      );
      instructionId = inserted.rows[0].id;
    }
    const { rows } = await client.query(
      `UPDATE ai_training_items
         SET verdict = $2, note = $3,
             instruction_id = COALESCE($4, instruction_id),
             reviewed_by = $5, reviewed_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, verdict, note || null, instructionId, req.session.userId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'البند غير موجود' });
    }
    await client.query('COMMIT');
    res.json({ item: rows[0], instruction_id: instructionId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to review a training item:', error.message);
    res.status(500).json({ error: 'تعذر حفظ التقييم' });
  } finally {
    client.release();
  }
}

// الرد الكويس بيتحوّل لصف في قاعدة المعرفة — **بموافقة صريحة، مش تلقائيًا مع التقييم**.
// نفس مبدأ الحصاد: النموذج بيقترح والأدمن بيكتب في المصدر. والنص قابل للتعديل قبل الحفظ لأن
// رد النموذج غالبًا محتاج تحرير بسيط قبل ما يبقى معلومة دايمة
async function promoteTrainingItem(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'البند غير صالح' });
  const question = String(req.body.question || '').trim();
  const answer = String(req.body.answer || '').trim();
  if (!question || !answer) return res.status(400).json({ error: 'السؤال والإجابة مطلوبين' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT knowledge_id FROM ai_training_items WHERE id = $1 FOR UPDATE', [id]
    );
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'البند غير موجود' });
    }
    // اتضاف قبل كده: الضغط مرتين على نفس الزرار مايعملش صفين متكررين في المصدر
    if (existing.rows[0].knowledge_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'الرد ده متضاف لقاعدة المعرفة بالفعل' });
    }
    const knowledge = await client.query(
      `INSERT INTO ai_knowledge (question, answer, source) VALUES ($1, $2, 'training')
       RETURNING id, question, answer`,
      [question, answer]
    );
    await client.query('UPDATE ai_training_items SET knowledge_id = $2 WHERE id = $1',
      [id, knowledge.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ knowledge: knowledge.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to promote a training answer to knowledge:', error.message);
    res.status(500).json({ error: 'تعذر إضافة الرد لقاعدة المعرفة' });
  } finally {
    client.release();
  }
}

module.exports = {
  listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply,
  listKnowledge, createKnowledge, updateKnowledge, deleteKnowledge, testKnowledge, getAiLog,
  updateAiSettings, chat, harvestChat, harvestFile, applyChanges, mineHistory, previewClusters,
  listInstructions, createInstruction, updateInstruction, deleteInstruction,
  searchTrainingTickets, startTraining, getTrainingRun, listTrainingRuns,
  reviewTrainingItem, promoteTrainingItem,
};
