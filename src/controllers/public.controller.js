const pool = require('../config/db');

// API عام (بدون تسجيل دخول) لنظام خارجي يبعت رقم تليفون الطالب ويستفسر هل بدأ محادثة Start مع
// البوت ولا لسه. المطابقة بترجع آخر 10 أرقام من رقم التليفون بعد شيل أي رموز، عشان تتطابق مهما كان
// شكل الرقم المُدخل (01xxxxxxxxx أو +201xxxxxxxxx أو 00201xxxxxxxxx)
async function getStudentStartStatus(req, res) {
  const rawPhone = String(req.query.phone || '').trim();
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 8) {
    return res.status(400).json({ error: 'رقم تليفون غير صالح' });
  }
  const last10 = digits.slice(-10);

  try {
    const result = await pool.query(
      `SELECT s.tafra_student_id, s.name, s.telegram_chat_id,
        (c.last_contacted_at IS NOT NULL) AS started
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       WHERE RIGHT(regexp_replace(s.phone, '\\D', '', 'g'), 10) = $1
       ORDER BY s.updated_at DESC
       LIMIT 1`,
      [last10]
    );
    const student = result.rows[0];
    if (!student) {
      return res.json({ found: false, started: false });
    }
    res.json({
      found: true,
      started: Boolean(student.started),
      tafra_student_id: Number(student.tafra_student_id),
      student_name: student.name,
      telegram_linked: Boolean(student.telegram_chat_id),
    });
  } catch (error) {
    console.error('❌ Failed to check student start status:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من حالة الطالب' });
  }
}

module.exports = { getStudentStartStatus };
