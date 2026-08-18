// الاسم الأول بس — بنفضّل اسم الطالب المسجّل على منصة طفرة (tafra_name) لأنه الاسم الحقيقي،
// وإلا بنرجع لبيانات تيليجرام (first_name/username) لو الطالب مش مرتبط بحساب على المنصة.
// دالة مستقلة هنا (مش جوّه broadcastSender.js) عشان أي كود يحتاجها (زي هاندلر /start) يقدر
// يستخدمها من غير ما يعمل require لـ broadcastSender.js نفسه — واللي بيعمل require لـ botManager.js،
// وده كان هيسبب دائرة استيراد (circular require) لو botManager.js هو أول حاجة بتتحمّل في السيرفر
// اللي مالوش حساب على المنصة بينادَى بصيغة محترمة حسب النوع بدل اسم تيليجرام: الأسماء دي
// بيكتبها الطالب بنفسه وساعات بتبقى لقب أو رموز (شفنا "ᗰ" و"حبيبي يا رسول الله")، ومناداة الطالب
// بيها في رسالة رسمية مش لايقة. النوع بيتخمّن من الاسم المتاح، وبيرجع للمذكر لو مش واضح
const { inferGenderFromName } = require('./genderInference');

function getFirstName(contact) {
  const platformName = String(contact.tafra_name || '').trim();
  if (platformName) return platformName.split(/\s+/)[0];

  const fallbackSource = String(contact.first_name || contact.telegram_username || '').trim();
  const gender = contact.gender || inferGenderFromName(fallbackSource);
  return gender === 'female' ? 'طالبتنا الكريمة' : 'طالبنا العزيز';
}

module.exports = { getFirstName };
