const pool = require('../config/db');

// API عام (بدون تسجيل دخول) لنظام خارجي يبعت رقم تليفون الطالب ويستفسر هل بدأ محادثة Start مع
// البوت ولا لسه. المطابقة بترجع آخر 10 أرقام من رقم التليفون بعد شيل أي رموز، عشان تتطابق مهما كان
// شكل الرقم المُدخل (01xxxxxxxxx أو +201xxxxxxxxx أو 00201xxxxxxxxx)
// الأرقام العربية الهندية (٠١٢) والفارسية (۰۱۲) بتتحوّل لأرقام عادية الأول.
// **من غير ده الرقم بيتمسح بالكامل** — `\D` بتعتبرهم رموز مش أرقام، فـ"٠١٠١٧٩٠٤١٥٠" بتبقى
// نص فاضي والرد بيبقى "رقم غير صالح". وده مش نادر: كيبورد الموبايل العربي بيطلّعهم افتراضيًا
function toAsciiDigits(value) {
  return String(value).replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    // ٠ = U+0660 (عربي هندي) و ۰ = U+06F0 (فارسي) — الاتنين متسلسلين من صفر لتسعة
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
}

// ---------- شرط الاشتراك ----------
//
// **المعنى المقصود من الـ API:** "أتصل بالطالب ده ولا لأ؟" مش "هو داخل البوت ولا لأ".
// `false` = اتصل بيه (مشترك في باب من اللي اتحددوا ولسه ما دخلش البوت)، و`true` = سيبه
// (إما داخل خلاص، أو مش مشترك أصلًا فمتابعته مضيعة وقت).
//
// **القايمة الفاضية معناها الشرط مقفول مش "مفيش أبواب"** — الفرق ده حرج: لو اتعاملنا مع
// الفاضي على إنه "مفيش طالب مشترك"، كل الطلاب هيرجعوا true والمتابعة كلها تقف من غير أي
// رسالة خطأ. فالفاضي بيرجّع سلوك الـ API الأصلي (دخول البوت بس)
async function selectedFollowUpBootcamps() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'api_follow_up_bootcamps'");
  const raw = String(rows[0]?.value || '').trim();
  return raw ? raw.split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id)) : [];
}

async function getStudentStartStatus(req, res) {
  const rawPhone = String(req.query.phone || '').trim();
  const digits = toAsciiDigits(rawPhone).replace(/\D/g, '');
  if (digits.length < 8) {
    return res.status(400).json({ error: 'رقم تليفون غير صالح' });
  }
  const last10 = digits.slice(-10);

  try {
    const bootcampIds = await selectedFollowUpBootcamps();
    const result = await pool.query(
      `SELECT s.tafra_student_id, s.name, s.telegram_chat_id,
        (c.last_contacted_at IS NOT NULL) AS started,
        -- أسماء الأبواب المحددة اللي الطالب مشترك فيها فعلًا. enrollment_type = 'enroll'
        -- هو نفس شرط "مشترك" المستخدم في توجيه الواتساب — مصدر واحد لمعنى الاشتراك
        ARRAY(
          SELECT b.name FROM tafra_enrollments e
          JOIN tafra_bootcamps b ON b.tafra_bootcamp_id = e.tafra_bootcamp_id
          WHERE e.tafra_student_id = s.tafra_student_id
            AND e.enrollment_type = 'enroll'
            AND e.tafra_bootcamp_id = ANY($2::bigint[])
          ORDER BY b.name
        ) AS enrolled_bootcamps
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       -- نفس تحويل toAsciiDigits لكن على الصف المتخزّن: فيه رقم متسجّل بأرقام هندية،
       -- و regexp_replace بتمسحها زي أي رمز فالرقم بيبقى فاضي والطالب مستحيل يتلاقى
       WHERE RIGHT(regexp_replace(translate(s.phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\\D', '', 'g'), 10) = $1
       ORDER BY s.updated_at DESC
       LIMIT 1`,
      [last10, bootcampIds]
    );
    const student = result.rows[0];
    // رقم مش على المنصة: مفيش اشتراك ومفيش حساب، فمفيش متابعة ليها معنى
    if (!student) {
      return res.json({ found: false, started: false, skip_follow_up: true, enrolled: null });
    }

    const started = Boolean(student.started);
    const conditionOn = bootcampIds.length > 0;
    const enrolled = conditionOn ? student.enrolled_bootcamps.length > 0 : null;
    res.json({
      found: true,
      started,
      tafra_student_id: Number(student.tafra_student_id),
      student_name: student.name,
      telegram_linked: Boolean(student.telegram_chat_id),
      // الحقل اللي المتابعة بتتبني عليه: true = سيبه · false = اتصل بيه
      skip_follow_up: started || (conditionOn && !enrolled),
      // null معناها شرط الأبواب مقفول من اللوحة — مش معناها "مش مشترك"
      enrolled,
      enrolled_bootcamps: student.enrolled_bootcamps,
    });
  } catch (error) {
    console.error('❌ Failed to check student start status:', error.message);
    res.status(500).json({ error: 'تعذر التحقق من حالة الطالب' });
  }
}

module.exports = { getStudentStartStatus };
