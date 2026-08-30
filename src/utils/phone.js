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

// ---------- تطبيع أرقام التليفون ----------
//
// نفس القاعدة اتكتبت في تلات أماكن (الـ API العام، ربط الطالب بنفسه، وطلب الرقم من البوت)،
// وأي اختلاف بينهم معناه إن رقم يتلاقى في مكان ومايتلاقاش في التاني. فاتجمّعت هنا.
//
// **الأرقام العربية الهندية لازم تتحوّل الأول.** `\D` بتعتبر ٠١٢ رموز مش أرقام فبتمسحها
// بالكامل، والرقم بيبقى نص فاضي — وده مش نادر: كيبورد الموبايل العربي بيطلّعهم افتراضيًا،
// وفيه أرقام متخزّنة على المنصة نفسها كده.

// نفس التحويل بلغة SQL — بيتحط على العمود المتخزّن في الاستعلامات
const SQL_TRANSLATE_DIGITS = "'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'";

function toAsciiDigits(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[٠-٩۰-۹]/g, (char) => {
      const code = char.charCodeAt(0);
      // ٠ = U+0660 (عربي هندي) و ۰ = U+06F0 (فارسي) — الاتنين متسلسلين من صفر لتسعة
      return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
    });
}

// **آخر ١٠ أرقام هي المفتاح.** نفس الرقم بيتخزّن بأشكال مختلفة (+٢٠، ٠٠٢٠، من غير صفر،
// بمسافات أو شرط)، وآخر عشرة بيتجاهل كل ده. أقل من ٨ خانات مش رقم أصلًا
function lastTenDigits(raw) {
  const digits = toAsciiDigits(raw).replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-10) : null;
}

module.exports = { toEgyptianMobileE164, toAsciiDigits, lastTenDigits, SQL_TRANSLATE_DIGITS };
