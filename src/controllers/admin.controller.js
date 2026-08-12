const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { generateLinkCode } = require('../bot/handlers/staffLink');

const SALT_ROUNDS = 12;
const VALID_ROLES = ['admin', 'agent'];

async function listUsers(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, is_active, can_view_tickets, can_view_calls, can_assign_calls, created_at,
        (telegram_chat_id IS NOT NULL) AS telegram_linked
       FROM users ORDER BY created_at`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Failed to load staff accounts:', error.message);
    res.status(500).json({ error: 'تعذر تحميل حسابات الفريق' });
  }
}

async function createUser(req, res) {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || 'agent');
  // صلاحيات العرض بتخص الموظف بس — تفعّل افتراضيًا (الاتنين) لو مش متحدد إيه غيره صراحة
  const canViewTickets = req.body.can_view_tickets === undefined ? true : Boolean(req.body.can_view_tickets);
  const canViewCalls = req.body.can_view_calls === undefined ? true : Boolean(req.body.can_view_calls);
  // "مسند" صلاحية أعلى من العرض العادي — متعطّلة افتراضيًا لو مش متحدد صراحة
  const canAssignCalls = Boolean(req.body.can_assign_calls);

  if (!name || !email || !password) return res.status(400).json({ error: 'الاسم والبريد وكلمة المرور مطلوبة' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'الدور غير صالح' });

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, can_view_tickets, can_view_calls, can_assign_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, is_active, can_view_tickets, can_view_calls, can_assign_calls, created_at`,
      [name, email, passwordHash, role, canViewTickets, canViewCalls, canAssignCalls]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    console.error('❌ Failed to create staff account:', error.message);
    res.status(500).json({ error: 'تعذر إنشاء الحساب' });
  }
}

async function updateUser(req, res) {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'الحساب غير صالح' });
  if (userId === Number(req.session.userId)) {
    return res.status(400).json({ error: 'لا يمكنك تغيير دور حسابك أو تعطيله بنفسك' });
  }

  const updates = [];
  const params = [];
  let passwordChanged = false;
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
    params.push(name);
    updates.push(`name = $${params.length}`);
  }
  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'البريد الإلكتروني مطلوب' });
    params.push(email);
    updates.push(`email = $${params.length}`);
  }
  if (req.body.role !== undefined) {
    if (!VALID_ROLES.includes(req.body.role)) return res.status(400).json({ error: 'الدور غير صالح' });
    params.push(req.body.role);
    updates.push(`role = $${params.length}`);
  }
  if (req.body.is_active !== undefined) {
    params.push(Boolean(req.body.is_active));
    updates.push(`is_active = $${params.length}`);
  }
  if (req.body.can_view_tickets !== undefined) {
    params.push(Boolean(req.body.can_view_tickets));
    updates.push(`can_view_tickets = $${params.length}`);
  }
  if (req.body.can_view_calls !== undefined) {
    params.push(Boolean(req.body.can_view_calls));
    updates.push(`can_view_calls = $${params.length}`);
  }
  if (req.body.can_assign_calls !== undefined) {
    params.push(Boolean(req.body.can_assign_calls));
    updates.push(`can_assign_calls = $${params.length}`);
  }
  if (req.body.password !== undefined) {
    const password = String(req.body.password || '');
    if (password.length < 8) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    }
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    params.push(passwordHash);
    updates.push(`password_hash = $${params.length}`);
    passwordChanged = true;
  }
  if (!updates.length) return res.status(400).json({ error: 'لا توجد تعديلات' });

  params.push(userId);
  try {
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, email, role, is_active, can_view_tickets, can_view_calls, can_assign_calls, created_at`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الحساب غير موجود' });
    if (passwordChanged) {
      await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(userId)]);
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    console.error('❌ Failed to update staff account:', error.message);
    res.status(500).json({ error: 'تعذر تحديث الحساب' });
  }
}

async function deleteUser(req, res) {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'الحساب غير صالح' });
  if (userId === Number(req.session.userId)) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك بنفسك' });
  }

  try {
    // لو لسه معاه طلاب مسندين، لازم يتعاد إسنادهم/يلغى إسنادهم الأول — حذف المستخدم كان هيمسحهم
    // تلقائيًا (CASCADE) من غير أي أثر غير سجل الإسناد، وده فقدان بيانات صامت مش مقصود
    const assignedResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM student_call_assignments WHERE assigned_to = $1',
      [userId]
    );
    const assignedCount = assignedResult.rows[0].count;
    if (assignedCount > 0) {
      return res.status(400).json({
        error: `الحساب لسه معاه ${assignedCount} طالب مسند — أعد إسنادهم لموظف تاني أو ألغِ إسنادهم من شاشة المتابعة التليفونية الأول`,
      });
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'الحساب غير موجود' });
    await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(userId)]);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete staff account:', error.message);
    res.status(500).json({ error: 'تعذر حذف الحساب' });
  }
}

// جلسات تسجيل الدخول النشطة حاليًا لكل موظف — بتقرأ مباشرة من جدول الجلسات (session)، فبتعكس
// الوضع الفعلي (بتختفي تلقائيًا لما الجلسة تنتهي أو يعمل تسجيل خروج). الجلسات القديمة اللي اتعملت
// قبل إضافة تتبع الجهاز مفيهاش deviceLabel، فبتظهر بعلامة "جهاز غير معروف" بدل ما تتجاهل
async function listSessions(req, res) {
  try {
    const sessionsResult = await pool.query(
      `SELECT sess->>'userId' AS user_id, sess->>'deviceLabel' AS device_label,
        sess->>'loginAt' AS login_at, expire
       FROM session
       WHERE expire > NOW()`
    );

    const sessionsByUser = new Map();
    for (const row of sessionsResult.rows) {
      const userId = Number(row.user_id);
      if (!Number.isInteger(userId)) continue;
      if (!sessionsByUser.has(userId)) sessionsByUser.set(userId, []);
      sessionsByUser.get(userId).push({
        device_label: row.device_label || 'جهاز غير معروف (دخل قبل تفعيل تتبع الأجهزة)',
        login_at: row.login_at,
        expire: row.expire,
      });
    }

    const usersResult = await pool.query(
      'SELECT id, name, email, role FROM users WHERE is_active = TRUE ORDER BY name'
    );
    const staff = usersResult.rows.map((user) => {
      const sessions = (sessionsByUser.get(user.id) || []).sort((a, b) => new Date(b.login_at || 0) - new Date(a.login_at || 0));
      return { ...user, session_count: sessions.length, sessions };
    });

    res.json(staff);
  } catch (error) {
    console.error('❌ Failed to load active sessions:', error.message);
    res.status(500).json({ error: 'تعذر تحميل جلسات تسجيل الدخول' });
  }
}

// تقرير أداء سريع لكل موظف — تذاكر صندوق الدعم المسندة له وحالتها، وطلاب المتابعة التليفونية
// المسندين له وهل تم الاتصال بيهم. بيظهر الجزء المناسب بس حسب صلاحيات عرض الموظف
// (can_view_tickets/can_view_calls)، والأدمن يشوف الاتنين دايمًا لو عنده تذاكر/طلاب مسندة له
async function getStaffStats(req, res) {
  try {
    const [ticketStats, callStats, usersResult] = await Promise.all([
      pool.query(`
        SELECT t.assigned_to AS user_id,
          COUNT(*)::int AS tickets_total,
          COUNT(*) FILTER (WHERE t.status NOT IN ('resolved', 'closed') AND (
            NOT EXISTS (SELECT 1 FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL)
            OR (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = t.contact_id) >
               (SELECT MAX(sm.sent_at) FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL)
          ))::int AS tickets_awaiting
        FROM tickets t
        WHERE t.assigned_to IS NOT NULL
        GROUP BY t.assigned_to
      `),
      pool.query(`
        SELECT sca.assigned_to AS user_id,
          COUNT(*)::int AS calls_total,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM call_logs cl WHERE cl.tafra_student_id = sca.tafra_student_id
          ))::int AS calls_done
        FROM student_call_assignments sca
        GROUP BY sca.assigned_to
      `),
      pool.query('SELECT id, role, can_view_tickets, can_view_calls FROM users'),
    ]);

    const ticketsByUser = new Map(ticketStats.rows.map((row) => [Number(row.user_id), row]));
    const callsByUser = new Map(callStats.rows.map((row) => [Number(row.user_id), row]));

    const stats = usersResult.rows.map((user) => {
      const showTickets = user.role === 'admin' || user.can_view_tickets;
      const showCalls = user.role === 'admin' || user.can_view_calls;
      const t = ticketsByUser.get(user.id);
      const c = callsByUser.get(user.id);
      return {
        id: user.id,
        tickets: showTickets ? {
          total: t?.tickets_total || 0,
          awaiting_reply: t?.tickets_awaiting || 0,
          handled: (t?.tickets_total || 0) - (t?.tickets_awaiting || 0),
        } : null,
        calls: showCalls ? {
          total: c?.calls_total || 0,
          done: c?.calls_done || 0,
          pending: (c?.calls_total || 0) - (c?.calls_done || 0),
        } : null,
      };
    });

    res.json(stats);
  } catch (error) {
    console.error('❌ Failed to load staff stats:', error.message);
    res.status(500).json({ error: 'تعذر تحميل تقرير أداء الموظفين' });
  }
}

// لوج نشاط الموظفين — مجمّع من مصدرين موجودين أصلًا (مكالمات اتسجّلت + أرقام أفكار اتحدّثت)،
// من غير أي جدول جديد. كل صف بيرجّع آخر موعد متابعة معروف (مش سجل تاريخي كامل لكل تغيير)
async function getStaffActivityLog(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  // الموظف (مش الأدمن) يشوف نشاطه هو بس — بيتجاهل أي user_id يبعته ويتقفل على حسابه هو، عشان
  // محدش يقدر يشوف أداء زميله ولو حاول يلعب بالـ query string يدويًا
  const userId = req.session.userRole === 'admin'
    ? (/^\d+$/.test(String(req.query.user_id || '')) ? Number(req.query.user_id) : null)
    : Number(req.session.userId);
  const from = req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;

  const activityCte = `
    WITH activity AS (
      SELECT 'call' AS activity_type, cl.called_by AS user_id, cl.called_at AS occurred_at,
        ts.name AS student_name, co.name AS detail, cl.notes, cl.next_follow_up_at,
        NULL::smallint AS idea_number
      FROM call_logs cl
      JOIN tafra_students ts ON ts.tafra_student_id = cl.tafra_student_id
      LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
      WHERE cl.called_by IS NOT NULL

      UNION ALL

      SELECT 'idea' AS activity_type, ipl.changed_by AS user_id, ipl.changed_at AS occurred_at,
        COALESCE(tsm.name, c.first_name, c.telegram_username) AS student_name, NULL AS detail, NULL AS notes,
        t.next_follow_up_at, ipl.idea_number
      FROM idea_progress_log ipl
      JOIN tickets t ON t.id = ipl.ticket_id
      JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN LATERAL (
        SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
      ) tsm ON true
      WHERE ipl.changed_by IS NOT NULL
    )
  `;

  const params = [];
  const conditions = [];
  if (userId) { params.push(userId); conditions.push(`a.user_id = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`a.occurred_at >= $${params.length}::date`); }
  if (to) { params.push(to); conditions.push(`a.occurred_at < ($${params.length}::date + INTERVAL '1 day')`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `${activityCte} SELECT COUNT(*)::int AS count FROM activity a ${where}`,
      params
    );
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `${activityCte}
       SELECT a.*, u.name AS user_name
       FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.occurred_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const total = countResult.rows[0].count;
    res.json({ activity: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('❌ Failed to load staff activity log:', error.message);
    res.status(500).json({ error: 'تعذر تحميل لوج نشاط الموظفين' });
  }
}

// تسجيل دخول الأدمن كموظف (Impersonation) — لأغراض الدعم/التصحيح. بيقتصر على موظفي الدعم (agent) بس،
// مش على أدمن تاني، وبيحفظ هوية الأدمن الأصلي في الجلسة عشان يقدر يرجع لحسابه بعدين (POST /stop-impersonation).
// أي إجراء يعمله الأدمن وهو "لابس" حساب الموظف (رد على تذكرة، تسجيل مكالمة...) هيتسجّل باسم الموظف
// نفسه، لأن الجلسة بقت فعليًا بتمثّله — ده سلوك مقصود ومتوقع من نظام Impersonation عادي
async function impersonateUser(req, res) {
  const targetUserId = Number(req.params.id);
  if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: 'الحساب غير صالح' });
  if (targetUserId === Number(req.session.userId)) {
    return res.status(400).json({ error: 'انت مسجّل دخول بالحساب ده بالفعل' });
  }
  if (req.session.impersonatorAdminId) {
    return res.status(400).json({ error: 'ارجع لحسابك الأول قبل ما تسجّل دخول كموظف تاني' });
  }

  try {
    const result = await pool.query(
      'SELECT id, name, role, is_active, can_view_tickets, can_view_calls, can_assign_calls FROM users WHERE id = $1',
      [targetUserId]
    );
    const target = result.rows[0];
    if (!target) return res.status(404).json({ error: 'الحساب غير موجود' });
    if (!target.is_active) return res.status(400).json({ error: 'الحساب ده متوقف' });
    if (target.role !== 'agent') {
      return res.status(400).json({ error: 'تسجيل الدخول متاح لحسابات موظفي الدعم بس، مش لحسابات الأدمن' });
    }

    req.session.impersonatorAdminId = req.session.userId;
    req.session.impersonatorAdminName = req.session.userName;
    req.session.userId = target.id;
    req.session.userName = target.name;
    req.session.userRole = target.role;
    req.session.canViewTickets = target.can_view_tickets;
    req.session.canViewCalls = target.can_view_calls;
    req.session.canAssignCalls = target.can_assign_calls;

    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to start impersonation:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل الدخول بحساب الموظف' });
  }
}

// كود ربط لمرة واحدة — الأدمن بيولّده ويدّيه للموظف (تليفونيًا/واتساب)، والموظف بيبعته للبوت
// بأمر /linkstaff عشان يربط حسابه الشخصي على تيليجرام بحسابه على لوحة التحكم
async function generateStaffTelegramLinkCode(req, res) {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'الحساب غير صالح' });

  try {
    const code = generateLinkCode();
    const result = await pool.query(
      'UPDATE users SET telegram_link_code = $1 WHERE id = $2 RETURNING id',
      [code, userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الحساب غير موجود' });
    res.json({ code });
  } catch (error) {
    console.error('❌ Failed to generate staff Telegram link code:', error.message);
    res.status(500).json({ error: 'تعذر إنشاء كود الربط' });
  }
}

module.exports = {
  listUsers, createUser, updateUser, deleteUser, listSessions, getStaffStats, impersonateUser,
  generateStaffTelegramLinkCode, getStaffActivityLog,
};
