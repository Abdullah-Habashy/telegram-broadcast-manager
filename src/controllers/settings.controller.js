const pool = require('../config/db');
const crypto = require('crypto');
const { encrypt, decrypt } = require('../utils/crypto');
const botManager = require('../bot/botManager');

async function getSettings(req, res) {
  try {
    const setupCodeResult = await pool.query("SELECT value FROM settings WHERE key = 'forward_setup_code'");
    if (!setupCodeResult.rows[0]?.value) {
      const setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      await pool.query("UPDATE settings SET value = $1 WHERE key = 'forward_setup_code'", [setupCode]);
    }

    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key NOT IN ('bot_token_encrypted', 'tafra_identifier_encrypted', 'tafra_password_encrypted')"
    );
    const settings = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));

    const tokenResult = await pool.query("SELECT value FROM settings WHERE key = 'bot_token_encrypted'");
    settings.bot_token_set = Boolean(tokenResult.rows[0]?.value);
    const profilesResult = await pool.query(
      `SELECT id, label, telegram_bot_id, bot_username, bot_name, is_active,
        last_verified_at, activated_at, created_at
       FROM bot_profiles ORDER BY is_active DESC, created_at DESC`
    );
    settings.bot_profiles = profilesResult.rows;

    res.json(settings);
  } catch (err) {
    console.error('❌ Failed to load settings:', err.message);
    res.status(500).json({ error: 'حصل خطأ في جلب الإعدادات' });
  }
}

async function createBotProfile(req, res) {
  const token = String(req.body.bot_token || '').trim();
  const requestedLabel = String(req.body.label || '').trim();
  if (!token) return res.status(400).json({ error: 'توكن البوت مطلوب' });
  if (requestedLabel.length > 100) return res.status(400).json({ error: 'اسم البوت داخل اللوحة أطول من الحد المسموح' });

  try {
    const botInfo = await botManager.verifyToken(token);
    const encrypted = encrypt(token);
    const label = requestedLabel || botInfo.first_name || `@${botInfo.username}`;
    const result = await pool.query(
      `INSERT INTO bot_profiles
        (label, telegram_bot_id, bot_username, bot_name, token_encrypted, created_by, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (telegram_bot_id) DO UPDATE SET
         label = EXCLUDED.label,
         bot_username = EXCLUDED.bot_username,
         bot_name = EXCLUDED.bot_name,
         token_encrypted = EXCLUDED.token_encrypted,
         last_verified_at = NOW()
       RETURNING id, label, telegram_bot_id, bot_username, bot_name, is_active, last_verified_at`,
      [label, botInfo.id, botInfo.username || null, botInfo.first_name || null, encrypted, req.session.userId]
    );
    res.status(201).json({ profile: result.rows[0], message: `تم حفظ @${botInfo.username} بعد التحقق منه` });
  } catch (error) {
    console.error('❌ Failed to verify/save bot profile:', error.message);
    res.status(400).json({ error: 'تعذر التحقق من البوت. تأكد من صحة التوكن وأنه غير ملغي' });
  }
}

async function activateBotProfile(req, res) {
  const profileId = Number(req.params.id);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: 'البوت المحدد غير صالح' });

  let previousToken = null;
  let switched = false;
  const client = await pool.connect();
  try {
    const targetResult = await client.query('SELECT * FROM bot_profiles WHERE id = $1', [profileId]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'البوت غير موجود' });
    if (target.is_active) return res.json({ ok: true, message: 'هذا البوت مفعّل بالفعل' });

    const previousResult = await client.query('SELECT token_encrypted FROM bot_profiles WHERE is_active = TRUE LIMIT 1');
    if (previousResult.rows[0]?.token_encrypted) previousToken = decrypt(previousResult.rows[0].token_encrypted);
    const targetToken = decrypt(target.token_encrypted);
    if (!targetToken) throw new Error('Stored bot token could not be decrypted');

    const botInfo = await botManager.verifyToken(targetToken);
    await botManager.activateToken(targetToken);
    switched = true;

    await client.query('BEGIN');
    await client.query('UPDATE bot_profiles SET is_active = FALSE WHERE is_active = TRUE');
    await client.query(
      `UPDATE bot_profiles SET is_active = TRUE, activated_at = NOW(), last_verified_at = NOW(),
        telegram_bot_id = $2, bot_username = $3, bot_name = $4 WHERE id = $1`,
      [profileId, botInfo.id, botInfo.username || null, botInfo.first_name || null]
    );
    await client.query("UPDATE settings SET value = $1 WHERE key = 'bot_token_encrypted'", [target.token_encrypted]);
    await client.query('COMMIT');
    res.json({ ok: true, message: `تم التحويل إلى @${botInfo.username} بنجاح` });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (switched && previousToken) {
      try { await botManager.activateToken(previousToken); } catch (rollbackError) {
        console.error('❌ Failed to restore previous bot after switch error:', rollbackError.message);
      }
    }
    console.error('❌ Failed to activate bot profile:', error.message);
    res.status(500).json({ error: 'فشل التحويل؛ تم الإبقاء على البوت السابق قدر الإمكان. تحقق من PUBLIC_URL والتوكن' });
  } finally {
    client.release();
  }
}

async function deleteBotProfile(req, res) {
  const profileId = Number(req.params.id);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: 'البوت المحدد غير صالح' });
  try {
    const result = await pool.query('DELETE FROM bot_profiles WHERE id = $1 AND is_active = FALSE RETURNING id', [profileId]);
    if (!result.rowCount) return res.status(400).json({ error: 'لا يمكن حذف البوت المفعّل؛ فعّل بوتًا آخر أولًا' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete bot profile:', error.message);
    res.status(500).json({ error: 'حصل خطأ في حذف البوت المحفوظ' });
  }
}

async function updateForwarding(req, res) {
  const { enabled } = req.body;
  try {
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'forwarding_enabled'", [String(Boolean(enabled))]);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update forwarding settings:', err.message);
    res.status(500).json({ error: 'حصل خطأ في تحديث إعدادات تحويل الرسائل' });
  }
}

async function updateFollowUpAutomation(req, res) {
  const { enabled, message } = req.body;
  const normalizedMessage = String(message || '').trim();
  if (Boolean(enabled) && !normalizedMessage) {
    return res.status(400).json({ error: 'اكتب نص رسالة المتابعة قبل التفعيل' });
  }
  if (normalizedMessage.length > 4096) {
    return res.status(400).json({ error: 'رسالة المتابعة أطول من الحد المسموح' });
  }
  try {
    await pool.query(
      `UPDATE settings SET value = CASE key
        WHEN 'follow_up_auto_enabled' THEN $1
        WHEN 'follow_up_auto_message' THEN $2
       END WHERE key IN ('follow_up_auto_enabled', 'follow_up_auto_message')`,
      [String(Boolean(enabled)), normalizedMessage]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update follow-up automation:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ رسالة المتابعة التلقائية' });
  }
}

// بيحفظ رسالة الترحيب والرد الفوري خارج مواعيد العمل مع بعض — الاتنين جزء من نفس التدفق
// (أول ارتباط بالبوت)، والرد الفوري مالوش معنى من غير رسالة ترحيب مفعّلة بتستنى وقت العمل
async function updateWelcomeMessage(req, res) {
  const { enabled, message, ack_enabled: ackEnabled, ack_message: ackMessage } = req.body;
  const normalizedMessage = String(message || '').trim();
  const normalizedAck = String(ackMessage || '').trim();
  if (Boolean(enabled) && !normalizedMessage) {
    return res.status(400).json({ error: 'اكتب نص رسالة الترحيب قبل التفعيل' });
  }
  if (normalizedMessage.length > 4096) {
    return res.status(400).json({ error: 'رسالة الترحيب أطول من الحد المسموح' });
  }
  if (Boolean(ackEnabled) && !normalizedAck) {
    return res.status(400).json({ error: 'اكتب نص الرد الفوري خارج مواعيد العمل قبل التفعيل' });
  }
  if (normalizedAck.length > 4096) {
    return res.status(400).json({ error: 'الرد الفوري خارج مواعيد العمل أطول من الحد المسموح' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES
        ('welcome_message_enabled', $1), ('welcome_message_text', $2),
        ('outside_hours_ack_enabled', $3), ('outside_hours_ack_text', $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(Boolean(enabled)), normalizedMessage, String(Boolean(ackEnabled)), normalizedAck]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update welcome message settings:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ رسالة الترحيب' });
  }
}

// قالب الـ SMS اللي الموظف يبعته للطالب اللي مردّش. الحد 918 حرف = 6 رسايل SMS بالعربي
// (الترميز اليوناني 153 حرف للرسالة في الرسايل المتصلة) — أطول من كده بيبقى غالي ومش مقروء
async function updateSmsTemplate(req, res) {
  const { enabled, message } = req.body;
  const normalizedMessage = String(message || '').trim();
  if (Boolean(enabled) && !normalizedMessage) {
    return res.status(400).json({ error: 'اكتب نص رسالة SMS قبل التفعيل' });
  }
  if (normalizedMessage.length > 918) {
    return res.status(400).json({ error: 'نص الـ SMS أطول من الحد المسموح (918 حرف)' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('sms_template_enabled', $1), ('sms_template_text', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(Boolean(enabled)), normalizedMessage]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update the SMS template:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ نص الـ SMS' });
  }
}

async function updateAgentIntroduction(req, res) {
  const { enabled, message } = req.body;
  const normalizedMessage = String(message || '').trim();
  if (Boolean(enabled) && !normalizedMessage) {
    return res.status(400).json({ error: 'اكتب نص تعريف الموظف قبل التفعيل' });
  }
  if (normalizedMessage.length > 4096) {
    return res.status(400).json({ error: 'رسالة تعريف الموظف أطول من الحد المسموح' });
  }
  if (Boolean(enabled) && !normalizedMessage.includes('{name}')) {
    return res.status(400).json({ error: 'نص التعريف يجب أن يحتوي على {name} لوضع اسم الموظف' });
  }
  try {
    await pool.query(
      `UPDATE settings SET value = CASE key
        WHEN 'agent_intro_enabled' THEN $1
        WHEN 'agent_intro_message' THEN $2
       END WHERE key IN ('agent_intro_enabled', 'agent_intro_message')`,
      [String(Boolean(enabled)), normalizedMessage]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update agent introduction settings:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ إعدادات تعريف الموظف' });
  }
}

async function saveBotToken(req, res) {
  const { bot_token } = req.body;
  if (!bot_token || !bot_token.trim()) {
    return res.status(400).json({ error: 'توكن البوت مطلوب' });
  }

  try {
    const encrypted = encrypt(bot_token.trim());
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'bot_token_encrypted'", [encrypted]);

    const bot = await botManager.initBot(); // إعادة تشغيل البوت فورًا بالتوكن الجديد
    if (!bot) {
      return res.status(400).json({
        error: 'التوكن اتحفظ بس فشل تفعيل البوت — تأكد إنه صحيح وإن PUBLIC_URL متحدد في .env',
      });
    }

    res.json({ ok: true, message: 'تم حفظ التوكن وتفعيل البوت بنجاح' });
  } catch (err) {
    console.error('❌ Failed to save the bot token:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ التوكن' });
  }
}

async function updateAutoReply(req, res) {
  const { enabled, message } = req.body;
  try {
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'auto_reply_enabled'", [String(Boolean(enabled))]);
    if (typeof message === 'string') {
      await pool.query("UPDATE settings SET value = $1 WHERE key = 'auto_reply_message'", [message]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update auto-reply settings:', err.message);
    res.status(500).json({ error: 'حصل خطأ في تحديث إعدادات الرد التلقائي' });
  }
}

async function updateWorkingHours(req, res) {
  const { enabled, start, end, message } = req.body;
  const normalizedMessage = String(message || '').trim();
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(start) || !timePattern.test(end)) {
    return res.status(400).json({ error: 'حدد مواعيد صحيحة (من/إلى)' });
  }
  if (Boolean(enabled) && !normalizedMessage) {
    return res.status(400).json({ error: 'اكتب نص الرد خارج مواعيد العمل قبل التفعيل' });
  }
  if (normalizedMessage.length > 4096) {
    return res.status(400).json({ error: 'نص الرد أطول من الحد المسموح' });
  }
  try {
    await pool.query(
      `UPDATE settings SET value = CASE key
        WHEN 'working_hours_enabled' THEN $1
        WHEN 'working_hours_start' THEN $2
        WHEN 'working_hours_end' THEN $3
        WHEN 'outside_hours_reply_message' THEN $4
       END WHERE key IN ('working_hours_enabled', 'working_hours_start', 'working_hours_end', 'outside_hours_reply_message')`,
      [String(Boolean(enabled)), start, end, normalizedMessage]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Failed to update working hours settings:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ مواعيد العمل' });
  }
}

async function updateMaxIdeaNumber(req, res) {
  const value = Number(req.body.max_idea_number);
  if (!Number.isInteger(value) || value < 1 || value > 999) {
    return res.status(400).json({ error: 'عدد الأفكار يجب أن يكون بين 1 و 999' });
  }
  try {
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'max_idea_number'", [String(value)]);
    res.json({ ok: true, max_idea_number: value });
  } catch (err) {
    console.error('❌ Failed to update max idea number:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ عدد الأفكار' });
  }
}

async function updateTafraAutoSyncInterval(req, res) {
  const value = Number(req.body.interval_hours);
  if (!Number.isInteger(value) || value < 1 || value > 168) {
    return res.status(400).json({ error: 'الفاصل الزمني يجب أن يكون بين 1 و 168 ساعة (أسبوع)' });
  }
  try {
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'tafra_auto_sync_interval_hours'", [String(value)]);
    // فاصل الاختبارات اختياري في نفس الطلب — لو مبعتش بنسيبه زي ما هو
    if (req.body.exam_interval_hours !== undefined) {
      const examValue = Number(req.body.exam_interval_hours);
      if (!Number.isInteger(examValue) || examValue < 1 || examValue > 168) {
        return res.status(400).json({ error: 'فاصل مزامنة الاختبارات يجب أن يكون بين 1 و 168 ساعة' });
      }
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('tafra_exam_auto_sync_interval_hours', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(examValue)]
      );
    }
    res.json({ ok: true, interval_hours: value });
  } catch (err) {
    console.error('❌ Failed to update Tafra auto-sync interval:', err.message);
    res.status(500).json({ error: 'حصل خطأ في حفظ الفاصل الزمني' });
  }
}

// أبواب شرط المتابعة في الـ API العام. بتتخزن كمعرّفات مفصولة بفاصلة — نفس شكل باقي
// فلاتر الاختيار المتعدد في اللوحة، فالواجهة بتتعامل معاها بنفس الأداة
async function updateApiFollowUpBootcamps(req, res) {
  const raw = String(req.body?.bootcamps ?? '').trim();
  const ids = raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [];
  // أي معرّف مش رقم بيترفض بالكامل بدل ما يتشال بالسكوت: لستة اتحفظت ناقصة معناها طلاب
  // بيرجعوا true وهما محتاجين متابعة، ومحدش هيلاحظ
  if (ids.some((id) => !/^\d+$/.test(id))) {
    return res.status(400).json({ error: 'قائمة الأبواب غير صالحة' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('api_follow_up_bootcamps', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [ids.join(',')]
    );
    res.json({ ok: true, bootcamps: ids });
  } catch (error) {
    console.error('❌ Failed to save the API follow-up bootcamps:', error.message);
    res.status(500).json({ error: 'تعذر حفظ شروط الـ API' });
  }
}

module.exports = {
  updateApiFollowUpBootcamps,
  getSettings,
  saveBotToken,
  updateAutoReply,
  updateForwarding,
  updateFollowUpAutomation,
  updateWelcomeMessage,
  updateSmsTemplate,
  updateAgentIntroduction,
  createBotProfile,
  activateBotProfile,
  deleteBotProfile,
  updateMaxIdeaNumber,
  updateTafraAutoSyncInterval,
  updateWorkingHours,
};
