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

module.exports = { requireAuth, requireAuthApi, requireAdminApi };
const pool = require('../config/db');
