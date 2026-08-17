// تصنيف أخطاء الإرسال الراجعة من تليجرام: فيه أخطاء مؤقتة (الشبكة، 429، عطل مؤقت عند تليجرام) تنفع
// معاها إعادة المحاولة، وفيه أخطاء **دائمة** خاصة بالمحادثة نفسها — إعادة المحاولة معاها مش بتنجح
// أبدًا مهما تكررت (الطالب حاظر البوت، أو حسابه محذوف، أو المحادثة مش موجودة). لازم نفرّق بينهم عشان
// المهام الدورية ما تدخلش في لوپ إعادة محاولة أبدي على خطأ مستحيل ينحل.

// النصوص اللي تليجرام بيرجعها في description للحالات الدائمة. المطابقة بالنص لأن نفس كود الحالة
// (403 أو 400) بيرجع كمان في حالات مؤقتة، فالكود لوحده مش كافي للتفرقة.
const PERMANENT_DESCRIPTIONS = [
  'bot was blocked by the user',
  'user is deactivated',
  'bot can\'t initiate conversation with a user',
  'bot was kicked',
  'chat not found',
  'user not found',
  'peer_id_invalid',
  'the group chat was deleted',
];

// Telegraf بيحط الكود والوصف في أماكن مختلفة حسب نوع الخطأ، وبيدمجهم كمان في message على شكل
// "403: Forbidden: bot was blocked by the user" — فبنجمع كل المصادر المحتملة ونفحصهم مع بعض
function isPermanentSendError(error) {
  if (!error) return false;
  const haystack = [
    error.description,
    error.response?.description,
    error.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return PERMANENT_DESCRIPTIONS.some((phrase) => haystack.includes(phrase));
}

module.exports = { isPermanentSendError };
