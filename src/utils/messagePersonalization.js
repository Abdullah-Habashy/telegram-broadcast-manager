// الاسم الأول بس — بنفضّل اسم الطالب المسجّل على منصة طفرة (tafra_name) لأنه الاسم الحقيقي،
// وإلا بنرجع لبيانات تيليجرام (first_name/username) لو الطالب مش مرتبط بحساب على المنصة.
// دالة مستقلة هنا (مش جوّه broadcastSender.js) عشان أي كود يحتاجها (زي هاندلر /start) يقدر
// يستخدمها من غير ما يعمل require لـ broadcastSender.js نفسه — واللي بيعمل require لـ botManager.js،
// وده كان هيسبب دائرة استيراد (circular require) لو botManager.js هو أول حاجة بتتحمّل في السيرفر
// اللي مالوش حساب على المنصة بينادَى بصيغة محترمة حسب النوع بدل اسم تيليجرام: الأسماء دي
// بيكتبها الطالب بنفسه وساعات بتبقى لقب أو رموز (شفنا "ᗰ" و"حبيبي يا رسول الله")، ومناداة الطالب
// بيها في رسالة رسمية مش لايقة. النوع بيتخمّن من الاسم المتاح، وبيرجع للمذكر لو مش واضح
const { inferGenderFromName } = require('./genderInference');

// **الاسم المركّب مش كلمة واحدة.** "عبد الرحمن طارق" أول كلمة فيه "عبد"، و"منة الله سمير"
// أول كلمة فيه "منة" — ومناداة الطالب بأي واحدة منهم لوحدها غلط.
//
// قاعدتين بيمشي بيهم الضم:
//   ١. الكلمة الحالية بادئة مالهاش معنى لوحدها (عبد، أبو، El) → ضم اللي بعدها.
//   ٢. الكلمة اللي بعدها لاحقة مالهاش معنى لوحدها (الله) → ضمها.
// والسقف تلات كلمات عشان اسم رباعي مايتحوّلش لمناداة طويلة.
//
// اتكشفت على بيانات الإنتاج: ١٠٩ طالب كانوا بيتنادوا "عبد" أو "أبو" في كل رسالة بيبعتها
// النظام — ترحيب وإرسال جماعي ومتابعة تلقائية ورسايل SMS
const COMPOUND_PREFIXES = new Set([
  'عبد', 'عبدال', 'ابو', 'أبو', 'ابن', 'بن', 'ام', 'أم',
  'abd', 'abdel', 'abdul', 'abo', 'abu', 'el', 'al',
]);
const COMPOUND_SUFFIXES = new Set(['الله', 'اللة', 'الدين', 'allah']);
const MAX_NAME_WORDS = 3;

function firstNameFrom(fullName) {
  const parts = String(fullName || '').split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  let taken = 1;
  while (taken < parts.length && taken < MAX_NAME_WORDS) {
    const current = parts[taken - 1].toLowerCase();
    const next = parts[taken].toLowerCase();
    if (COMPOUND_PREFIXES.has(current) || COMPOUND_SUFFIXES.has(next)) { taken += 1; continue; }
    break;
  }
  return parts.slice(0, taken).join(' ');
}

function getFirstName(contact) {
  const platformName = String(contact.tafra_name || '').trim();
  if (platformName) return firstNameFrom(platformName);

  const fallbackSource = String(contact.first_name || contact.telegram_username || '').trim();
  const gender = contact.gender || inferGenderFromName(fallbackSource);
  return gender === 'female' ? 'طالبتنا الكريمة' : 'طالبنا العزيز';
}

module.exports = { getFirstName, firstNameFrom };
