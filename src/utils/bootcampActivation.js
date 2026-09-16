// ---------- تفعيل باب لمجموعة أرقام ----------
//
// **الجزء الخطير هنا هو المطابقة، مش النداء على المنصة.** رقم اتطابق غلط معناه إن طالب
// ياخد محتوى مدفوع مش بتاعه، وطالب دافع يفضل مقفول عليه. عشان كده المطابقة مكتوبة هنا
// لوحدها، ومتجرّبة على بيانات الإنتاج، ومفصولة تمامًا عن أي كتابة.
//
// **والمعاينة بتمشي نفس الكود بالظبط.** لو المعاينة بمنطق تاني، اللي الأدمن شافه مش هو
// اللي هيحصل — ودي الحالة اللي بيتقال فيها "بس أنا شفت الرقم في القايمة".

const pool = require('../config/db');
const { lastTenDigits, SQL_TRANSLATE_DIGITS } = require('./phone');

// حد على عدد الأرقام في المرة الواحدة: كل رقم بيتحوّل لنداء على المنصة، والقايمة اللي
// اتلزقت بالغلط (ملف كامل مثلًا) بتبقى مئات النداءات قبل ما حد ياخد باله
const MAX_PHONES = 500;

// **بنقبل أي فاصل.** الأرقام بتتلزق من إكسل أو واتساب أو تيليجرام، وكل واحد بيحط فاصل
// مختلف — سطر جديد، فاصلة، مسافة، أو الاتنين مع بعض
function parsePhoneList(raw) {
  const seen = new Set();
  const phones = [];
  const invalid = [];

  for (const piece of String(raw || '').split(/[\s,;،؛\n\r]+/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const phone = lastTenDigits(trimmed);
    if (!phone) { invalid.push(trimmed.slice(0, 20)); continue; }
    // **التكرار بيتشال هنا مش على المنصة.** نفس الرقم مرتين في القايمة معناه نداءين
    // على نفس الطالب، والتاني بيرجع "مشترك بالفعل" ويبان كإنه مشكلة
    if (seen.has(phone)) continue;
    seen.add(phone);
    phones.push(phone);
  }

  return { phones, invalid, truncated: phones.length > MAX_PHONES ? phones.length - MAX_PHONES : 0 };
}

// بترجّع صف لكل رقم بحالته: اتلقى ومش مشترك، مشترك بالفعل، ولا مش موجود على المنصة.
// **الاستعلام واحد لكل الأرقام** — نداء لكل رقم على ٥٠٠ رقم بيقفل الاتصالات على الشغل الجاري
async function matchPhones(phones, bootcampId) {
  if (!phones.length) return [];

  const { rows } = await pool.query(
    `WITH wanted AS (SELECT unnest($1::text[]) AS phone)
     SELECT w.phone,
            s.tafra_student_id,
            s.name AS student_name,
            EXISTS (
              SELECT 1 FROM tafra_enrollments e
              WHERE e.tafra_student_id = s.tafra_student_id
                AND e.tafra_bootcamp_id = $2
                AND e.enrollment_type IN ('enroll', 'renew')
            ) AS already_enrolled
     FROM wanted w
     LEFT JOIN LATERAL (
       SELECT t.tafra_student_id, t.name
       FROM tafra_students t
       WHERE RIGHT(REGEXP_REPLACE(translate(t.phone, ${SQL_TRANSLATE_DIGITS}), '[^0-9]', '', 'g'), 10) = w.phone
       ORDER BY t.tafra_student_id
       LIMIT 1
     ) s ON TRUE`,
    [phones, Number(bootcampId)]
  );

  // ترتيب النتيجة زي ما الأدمن لزق الأرقام — أسهل في المراجعة من ترتيب القاعدة
  const byPhone = new Map(rows.map((r) => [r.phone, r]));
  return phones.map((phone) => {
    const row = byPhone.get(phone) || {};
    const status = !row.tafra_student_id ? 'unknown' : row.already_enrolled ? 'already' : 'matched';
    return {
      phone,
      tafra_student_id: row.tafra_student_id || null,
      student_name: row.student_name || null,
      status,
    };
  });
}

function summarize(entries) {
  const counts = { matched: 0, already: 0, unknown: 0, done: 0, failed: 0 };
  for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1;
  return counts;
}

module.exports = { MAX_PHONES, parsePhoneList, matchPhones, summarize };
