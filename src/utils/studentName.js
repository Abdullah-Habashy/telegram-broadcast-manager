const pool = require('../config/db');

// ---------- اسم الطالب المعروض ----------
//
// **الاسم على منصة طفرة هو الاسم الحقيقي.** اسم تيليجرام بيكتبه الطالب بنفسه وساعات بيبقى
// لقب أو رموز أو فاضي خالص (شفنا "ᗰ" و"حبيبي يا رسول الله")، والموظف اللي بيتابع طالب
// مش بيعرفه بالاسم ده. فأي مكان بيعرض اسم طالب — قايمة، إشعار، تصدير، رسالة محوّلة —
// بياخد اسم المنصة الأول، وبيرجع لتيليجرام بس لو الطالب مش مربوط بحساب.
//
// الترتيب مكتوب هنا مرة واحدة عشان مايفترقش بين الشاشات: قبل الملف ده كان في تلات صيغ
// مختلفة (SQL في التذاكر، جافاسكريبت في اللوحة، وسلسلة تيليجرام في الإشعارات)، وكان
// نفس الطالب بيظهر باسمين مختلفين في شاشتين.

// الجوين بيفترض إن جدول contacts اسمه المستعار c — نفس ما هو مستخدم في كل استعلامات المشروع
const TAFRA_NAME_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
  ) tafra_match ON TRUE`;

// NULLIF(TRIM(...)) مش COALESCE لوحدها: الاسم الفاضي أو المسافات في القاعدة قيمة موجودة
// مش NULL، وCOALESCE كانت هتقف عندها وتعرض فراغ بدل ما تكمّل للبديل
const DISPLAY_NAME_SQL = `COALESCE(
  NULLIF(TRIM(tafra_match.name), ''),
  NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
  NULLIF(TRIM(c.telegram_username), ''),
  c.chat_id::text
)`;

// نفس الترتيب في الجافاسكريبت — للكود اللي معاه الصف في الذاكرة مش في استعلام
function displayName(row) {
  if (!row) return 'بدون اسم';
  const platform = String(row.tafra_name || row.platform_name || '').trim();
  if (platform) return platform;
  const telegram = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return telegram || String(row.telegram_username || row.username || '').trim() || String(row.chat_id || 'بدون اسم');
}

// للمسارات اللي عندها chat_id بس (الإشعارات والتحويل): استعلام واحد على فهرس موجود
// (idx_tafra_students_chat_id). الفشل بيرجّع null والمنادي بيكمّل ببيانات تيليجرام —
// مشكلة في قراءة اسم مايوقفش وصول إشعار برسالة طالب
async function platformNameFor(chatId) {
  try {
    const { rows } = await pool.query(
      'SELECT name FROM tafra_students WHERE telegram_chat_id = $1 LIMIT 1', [chatId]);
    return String(rows[0]?.name || '').trim() || null;
  } catch (error) {
    console.error('❌ Failed to look up the platform name:', error.message);
    return null;
  }
}

module.exports = { TAFRA_NAME_JOIN_SQL, DISPLAY_NAME_SQL, displayName, platformNameFor };
