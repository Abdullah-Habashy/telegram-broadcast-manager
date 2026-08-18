const pool = require('../config/db');

// ---------- علامة "عاجل" ----------
// بتتخزن على contacts و tafra_students مع بعض: ولا واحدة لوحدها بتغطي كل الحالات (طلاب متابعة
// من غير تليجرام، وتذاكر لأشخاص مش طلاب منصة). التبديل بيكتب على الجهتين لو الربط موجود،
// فالعلامة تفضل واحدة سواء فتحت الطالب من المتابعة أو من صندوق الدعم
async function setUrgentFlag({ tafraStudentId = null, contactId = null, isUrgent }) {
  const flag = Boolean(isUrgent);
  // بنحل الهويتين من أي طرف متاح، عشان الكتابة تلمس الصفين لو الطالب موجود في الاتنين
  const resolved = await pool.query(
    `SELECT s.tafra_student_id, c.id AS contact_id
     FROM tafra_students s
     FULL JOIN contacts c ON c.chat_id = s.telegram_chat_id
     WHERE ($1::bigint IS NOT NULL AND s.tafra_student_id = $1)
        OR ($2::int IS NOT NULL AND c.id = $2)
     LIMIT 1`,
    [tafraStudentId, contactId]
  );
  const row = resolved.rows[0] || {};
  const studentId = row.tafra_student_id ?? tafraStudentId;
  const linkedContactId = row.contact_id ?? contactId;

  if (studentId) {
    await pool.query('UPDATE tafra_students SET is_urgent = $2 WHERE tafra_student_id = $1', [studentId, flag]);
  }
  if (linkedContactId) {
    await pool.query('UPDATE contacts SET is_urgent = $2 WHERE id = $1', [linkedContactId, flag]);
  }
  if (!studentId && !linkedContactId) return null;
  return flag;
}

module.exports = { setUrgentFlag };
