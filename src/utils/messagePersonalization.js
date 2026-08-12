// الاسم الأول بس — بنفضّل اسم الطالب المسجّل على منصة طفرة (tafra_name) لأنه الاسم الحقيقي،
// وإلا بنرجع لبيانات تيليجرام (first_name/username) لو الطالب مش مرتبط بحساب على المنصة.
// دالة مستقلة هنا (مش جوّه broadcastSender.js) عشان أي كود يحتاجها (زي هاندلر /start) يقدر
// يستخدمها من غير ما يعمل require لـ broadcastSender.js نفسه — واللي بيعمل require لـ botManager.js،
// وده كان هيسبب دائرة استيراد (circular require) لو botManager.js هو أول حاجة بتتحمّل في السيرفر
function getFirstName(contact) {
  const source = contact.tafra_name || contact.first_name || contact.telegram_username || '';
  return String(source).trim().split(/\s+/)[0] || 'صديقنا';
}

module.exports = { getFirstName };
