// أرقام الطلاب جاية من منصة طفرة بشكلين مختلفين في نفس العمود: دولي (+201xxxxxxxxx) ومحلي
// (01xxxxxxxxx). روابط sms: و tel: بتشتغل أضمن بالشكل الدولي على كل الأجهزة، فبنوحّدهم قبل الاستخدام.
// أي رقم مش موبايل مصري بالشكل المتوقع بترجع null — والمنادي بيقرر يخفي الزرار وقتها بدل ما
// يفتح تطبيق الرسائل على رقم غلط
function toEgyptianMobileE164(raw) {
  if (!raw) return null;
  // بنشيل المسافات والشُرَط والأقواس اللي بتيجي في الأرقام المكتوبة بالإيد
  const digitsOnly = String(raw).replace(/[\s()\-.]/g, '');
  const bare = digitsOnly.replace(/^\+/, '');

  // 01xxxxxxxxx  ->  +201xxxxxxxxx
  if (/^01[0-9]{9}$/.test(bare)) return `+20${bare.slice(1)}`;
  // 201xxxxxxxxx ->  +201xxxxxxxxx  (وبيغطي +201xxxxxxxxx كمان بعد شيل علامة +)
  if (/^201[0-9]{9}$/.test(bare)) return `+${bare}`;
  // 1xxxxxxxxx   ->  +201xxxxxxxxx  (رقم مكتوب من غير الصفر ولا كود الدولة)
  if (/^1[0-9]{9}$/.test(bare)) return `+20${bare}`;

  return null;
}

module.exports = { toEgyptianMobileE164 };
