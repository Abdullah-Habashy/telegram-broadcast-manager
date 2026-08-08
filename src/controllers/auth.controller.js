const bcrypt = require('bcrypt');
const pool = require('../config/db');

const SALT_ROUNDS = 12;

async function showLogin(req, res) {
  if (req.session?.userId) return res.redirect('/');
  res.render('login', { error: null });
}

async function showRegister(req, res) {
  if (req.session?.userId) return res.redirect('/');
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (countResult.rows[0].count > 0) {
    return res.status(403).render('register', { error: 'التسجيل العام مغلق. اطلب من المدير إنشاء حساب لك.' });
  }
  res.render('register', { error: null });
}

async function register(req, res) {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.render('register', { error: 'من فضلك املأ كل الحقول' });
  }
  if (password.length < 8) {
    return res.render('register', { error: 'كلمة المرور لازم تكون 8 حروف على الأقل' });
  }

  try {
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    if (countResult.rows[0].count > 0) {
      return res.status(403).render('register', { error: 'التسجيل العام مغلق. اطلب من المدير إنشاء حساب لك.' });
    }
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.render('register', { error: 'الإيميل ده مسجّل قبل كده' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id, role",
      [name, email.toLowerCase(), passwordHash]
    );

    req.session.userId = result.rows[0].id;
    req.session.userName = name;
    req.session.userRole = result.rows[0].role;
    res.redirect('/');
  } catch (err) {
    console.error('Registration failed:', err.message);
    res.render('register', { error: 'حصل خطأ غير متوقع، حاول تاني' });
  }
}

async function login(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('login', { error: 'من فضلك املأ كل الحقول' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];

    if (!user) {
      return res.render('login', { error: 'الإيميل أو كلمة المرور غلط' });
    }

    if (!user.is_active) {
      return res.render('login', { error: 'الحساب متوقف. تواصل مع المدير.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.render('login', { error: 'الإيميل أو كلمة المرور غلط' });
    }

    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userRole = user.role;
    res.redirect('/');
  } catch (err) {
    console.error('Sign-in failed:', err.message);
    res.render('login', { error: 'حصل خطأ غير متوقع، حاول تاني' });
  }
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}

module.exports = { showLogin, showRegister, register, login, logout };
