// يمنع الوصول للصفحات المحمية غير لو المستخدم مسجّل دخول
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.redirect('/login');
}

// نفس الفكرة بس بيرجع JSON بدل redirect — لاستخدامه في مسارات الـ API
function requireAuthApi(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'غير مصرح — سجّل الدخول الأول' });
}

async function requireAdminApi(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'غير مصرح — سجّل الدخول الأول' });
  }
  try {
    const result = await pool.query('SELECT role, is_active FROM users WHERE id = $1', [req.session.userId]);
    const user = result.rows[0];
    if (!user?.is_active) {
      return req.session.destroy(() => res.status(401).json({ error: 'الحساب غير مفعّل' }));
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'هذه العملية متاحة للمدير فقط' });
    }
    req.session.userRole = user.role;
    next();
  } catch (error) {
    console.error('❌ Failed to verify admin permissions:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من الصلاحيات' });
  }
}

// صلاحيات عرض صندوق الدعم/المتابعة التليفونية — بتتحقق من قاعدة البيانات مباشرة في كل طلب (زي
// requireAdminApi بالظبط)، مش من قيمة مخزّنة في الجلسة من وقت تحميل الصفحة. السبب: لو موظف فاتح تاب
// من قبل ما تتغيّر صلاحياته (أو حتى قبل ما الميزة دي تتضاف أصلًا)، وسيبه مفتوح من غير Refresh لأيام،
// الجلسة القديمة كانت بتفضل من غير canViewTickets خالص فيترفض كل طلب — نفس السبب اللي كان بيمنع
// صندوق الدعم يظهر لموظف حتى بعد ما نديله الصلاحية، لحد ما يعمل تسجيل خروج ودخول تاني
async function requireTicketsAccessApi(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'غير مصرح — سجّل الدخول الأول' });
  }
  try {
    const result = await pool.query(
      'SELECT role, is_active, can_view_tickets, team FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (!user?.is_active) {
      return req.session.destroy(() => res.status(401).json({ error: 'الحساب غير مفعّل' }));
    }
    const canView = user.role === 'admin' || user.can_view_tickets;
    req.session.userRole = user.role;
    req.session.canViewTickets = canView;
    // بيحدد الموظف بيشوف أنهي تذاكر: موظف المتابعة بيشوف المسندة له، والمتخصص بيشوف المحوّلة له
    req.session.userTeam = user.role === 'admin' ? null : (user.team || null);
    if (!canView) return res.status(403).json({ error: 'مفيش صلاحية لعرض صندوق الدعم' });
    next();
  } catch (error) {
    console.error('❌ Failed to verify tickets access:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من الصلاحيات' });
  }
}

async function requireCallsAccessApi(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'غير مصرح — سجّل الدخول الأول' });
  }
  try {
    const result = await pool.query(
      'SELECT role, is_active, can_view_calls FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (!user?.is_active) {
      return req.session.destroy(() => res.status(401).json({ error: 'الحساب غير مفعّل' }));
    }
    const canView = user.role === 'admin' || user.can_view_calls;
    req.session.userRole = user.role;
    req.session.canViewCalls = canView;
    if (!canView) return res.status(403).json({ error: 'مفيش صلاحية لعرض المتابعة التليفونية' });
    next();
  } catch (error) {
    console.error('❌ Failed to verify calls access:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من الصلاحيات' });
  }
}

// صلاحية "مسند" — تسمح بإسناد/إلغاء إسناد طلاب متابعة المكالمات لموظفين تانيين، من غير ما يكون
// المستخدم أدمن. نفس نمط requireTicketsAccessApi/requireCallsAccessApi (تحقق مباشر من قاعدة البيانات
// في كل طلب، مش من الجلسة، عشان أي تغيير في الصلاحية ينعكس فورًا حتى لو الجلسة قديمة)
async function requireCallAssignAccessApi(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'غير مصرح — سجّل الدخول الأول' });
  }
  try {
    const result = await pool.query(
      'SELECT role, is_active, can_assign_calls FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (!user?.is_active) {
      return req.session.destroy(() => res.status(401).json({ error: 'الحساب غير مفعّل' }));
    }
    const canAssign = user.role === 'admin' || user.can_assign_calls;
    req.session.userRole = user.role;
    req.session.canAssignCalls = canAssign;
    if (!canAssign) return res.status(403).json({ error: 'مفيش صلاحية لإسناد طلاب المتابعة التليفونية' });
    next();
  } catch (error) {
    console.error('❌ Failed to verify call-assign permissions:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من الصلاحيات' });
  }
}

// صلاحية بناء الاختبارات ومراجعة تصحيحها: الأدمن + التيم العلمي + الدعم الفني. التيمات
// جاية من utils/teams.js مش مكتوبة هنا، عشان تفضل مصدر واحد مع اللي بيقرر ظهور التبويب
// في اللوحة. نفس نمط requireTicketsAccessApi: تحقق من قاعدة البيانات في كل طلب مش من
// الجلسة، فأي تغيير في تيم الموظف بينفّذ فورًا من غير ما يعمل خروج ودخول
async function requireQuizAccessApi(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'غير مصرح — سجّل الدخول الأول' });
  }
  try {
    const result = await pool.query('SELECT role, is_active, team FROM users WHERE id = $1', [req.session.userId]);
    const user = result.rows[0];
    if (!user?.is_active) {
      return req.session.destroy(() => res.status(401).json({ error: 'الحساب غير مفعّل' }));
    }
    const allowed = user.role === 'admin' || canManageQuizzes(user.team);
    req.session.userRole = user.role;
    req.session.canManageQuizzes = allowed;
    if (!allowed) return res.status(403).json({ error: 'الاختبارات متاحة للمدير والتيم العلمي والدعم الفني' });
    next();
  } catch (error) {
    console.error('❌ Failed to verify quiz permissions:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من الصلاحيات' });
  }
}

module.exports = {
  requireAuth, requireAuthApi, requireAdminApi, requireTicketsAccessApi, requireCallsAccessApi,
  requireCallAssignAccessApi, requireQuizAccessApi,
};
const pool = require('../config/db');
const { canManageQuizzes } = require('../utils/teams');
