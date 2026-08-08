const bcrypt = require('bcrypt');
const pool = require('../config/db');

const SALT_ROUNDS = 12;
const VALID_ROLES = ['admin', 'agent'];

async function listUsers(req, res) {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at'
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

  if (!name || !email || !password) return res.status(400).json({ error: 'الاسم والبريد وكلمة المرور مطلوبة' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'الدور غير صالح' });

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active, created_at`,
      [name, email, passwordHash, role]
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
  if (req.body.role !== undefined) {
    if (!VALID_ROLES.includes(req.body.role)) return res.status(400).json({ error: 'الدور غير صالح' });
    params.push(req.body.role);
    updates.push(`role = $${params.length}`);
  }
  if (req.body.is_active !== undefined) {
    params.push(Boolean(req.body.is_active));
    updates.push(`is_active = $${params.length}`);
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
       RETURNING id, name, email, role, is_active, created_at`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'الحساب غير موجود' });
    if (passwordChanged) {
      await pool.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(userId)]);
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to update staff account:', error.message);
    res.status(500).json({ error: 'تعذر تحديث الحساب' });
  }
}

module.exports = { listUsers, createUser, updateUser };
