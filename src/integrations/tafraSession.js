const { TafraReadOnlyClient } = require('./tafraClient');

// ---------- جلسة واحدة مشتركة مع منصة طفرة ----------
//
// **المنصة بتسمح بجلسة واحدة بس لكل حساب.** اتقاست: سجّلنا دخول مرتين بنفس البيانات،
// والطلب بالتوكن الأول رجّع "يجب أن تكون مسجل الدخول" فورًا بعد تسجيل التاني.
//
// وده كان بيوقّع مزامنة الطلاب من غير سبب ظاهر: المزامنة بتاخد ساعة، وفي الساعة دي بيسجّل
// دخول **كل** واحد من دول بحساب مستقل وياخد الجلسة منها:
//   • مزامنة الاختبارات (كل ١٥ دقيقة)
//   • توزيع المكالمات التلقائي (كل ١٠ دقايق)
//   • **وأي موظف بيفتح كارت تقرير طالب** — ده بيجيب المشاهدات لحظيًا من المنصة
//
// فبدل ما كل واحد يعمل عميل جديد، الكل بياخد نفس العميل — تسجيل دخول واحد وتوكن واحد،
// والعميل نفسه بيجدّده لو انتهى.
//
// **الاستثناء الوحيد** التحقق من بيانات دخول جديدة في saveCredentials: ده لازم يجرّب
// البيانات اللي الأدمن كتبها مش المحفوظة، فبيعمل عميل مؤقت لوحده.

let shared = null;
let sharedKey = null;

function getSharedClient(credentials) {
  if (!credentials?.identifier || !credentials?.password) return null;
  // لو الأدمن غيّر بيانات الدخول، العميل القديم بيتترمي — التوكن بتاعه بقى لحساب تاني
  const key = `${credentials.identifier}\u0000${credentials.password}`;
  if (!shared || sharedKey !== key) {
    shared = new TafraReadOnlyClient(credentials.identifier, credentials.password);
    sharedKey = key;
  }
  return shared;
}

// بيتنادى بعد حفظ بيانات دخول جديدة عشان النداء الجاي يعمل عميل بالبيانات الجديدة
function resetSharedClient() {
  shared = null;
  sharedKey = null;
}

module.exports = { getSharedClient, resetSharedClient };
