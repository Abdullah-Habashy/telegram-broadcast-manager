const pool = require('../config/db');

// ---------- علامة "عاجل" ----------
// بتتخزن على contacts و tafra_students مع بعض: ولا واحدة لوحدها بتغطي كل الحالات (طلاب متابعة
// من غير تليجرام، وتذاكر لأشخاص مش طلاب منصة). التبديل بيكتب على الجهتين لو الربط موجود،
// فالعلامة تفضل واحدة سواء فتحت الطالب من المتابعة أو من صندوق الدعم

// العلامة مربوطة كمان بأولوية التذكرة (tickets.priority) في الاتجاهين: الوسم بيرفع الأولوية
// لـ 'urgent' وإلغاؤه بيرجّعها 'normal'، والعكس في updateTicket. من غير الربط ده كان فلتر
// "الأولويات: عاجلة" بيرجع فاضي رغم إن فيه محادثات موسومة 🚨 — حقلين مختلفين بنفس المعنى
// للمستخدم. التذكرة واحدة لكل جهة اتصال (contacts.id UNIQUE في tickets) فالربط واحد-لواحد

// خفض الأولوية مشروط بإنها 'urgent' حاليًا: تذكرة أولويتها "منخفضة" واتوسمت عاجل ثم اتلغى
// الوسم لازم ترجع 'normal' — لكن لو الأولوية اتغيّرت يدويًا في النص، مالناش دعوة بيها
function prioritySync(flag) {
  return flag
    ? { next: 'urgent', guard: "priority <> 'urgent'" }
    : { next: 'normal', guard: "priority = 'urgent'" };
}

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
    const { next, guard } = prioritySync(flag);
    await pool.query(
      `UPDATE tickets SET priority = $2, updated_at = NOW() WHERE contact_id = $1 AND ${guard}`,
      [linkedContactId, next]
    );
  }
  if (!studentId && !linkedContactId) return null;
  return flag;
}


// نسخة جماعية: جملتين بس مهما كان العدد، بدل استدعاء setUrgentFlag لكل طالب. بتكتب على
// tafra_students وعلى صفوف contacts المرتبطة بيهم عن طريق telegram_chat_id
async function setUrgentFlagBulk(tafraStudentIds, isUrgent) {
  const ids = [...new Set((tafraStudentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return 0;
  const flag = Boolean(isUrgent);

  const updated = await pool.query(
    'UPDATE tafra_students SET is_urgent = $2 WHERE tafra_student_id = ANY($1::bigint[]) RETURNING tafra_student_id',
    [ids, flag]
  );
  await pool.query(
    `UPDATE contacts SET is_urgent = $2
     WHERE chat_id IN (SELECT telegram_chat_id FROM tafra_students
                       WHERE tafra_student_id = ANY($1::bigint[]) AND telegram_chat_id IS NOT NULL)`,
    [ids, flag]
  );
  // نفس ربط الأولوية بتاع setUrgentFlag — الوسم الجماعي من شاشة المتابعة لازم يظهر في فلتر
  // الأولويات بتاع صندوق الدعم بالظبط زي الوسم الفردي
  const { next, guard } = prioritySync(flag);
  await pool.query(
    `UPDATE tickets SET priority = $2, updated_at = NOW()
     WHERE ${guard} AND contact_id IN (
       SELECT c.id FROM contacts c
       JOIN tafra_students s ON s.telegram_chat_id = c.chat_id
       WHERE s.tafra_student_id = ANY($1::bigint[]))`,
    [ids, next]
  );
  return updated.rowCount;
}

module.exports = { setUrgentFlag, setUrgentFlagBulk };
