// ---------- مين «الطالب المشترك»؟ ----------
//
// السؤال ده بيتسأل في مكانين في البوت — أنهي زراير يشوفها الطالب، وهل يُسمح له يحوّل
// نفسه للتيم العلمي — والإجابة لازم تكون واحدة في الاتنين، وإلا الطالب بيشوف زرار
// بيترفض لما يدوسه.
//
// **مش كل اشتراك اشتراك.** كورس التأسيس مجاني ومفتوح لأي حد، وفيه ٤٠٢٢ طالب — لو حسبناه
// اشتراك يبقى التيم العلمي مفتوح لكل اللي دخلوا المنصة. اللي بيدّي الحق هو الكورسات
// المدفوعة (الأبواب وكورس المنهج الكامل)، وهي متعلّمة في `tafra_bootcamps.grants_support`
// من اللوحة — عشان الباب التالت والرابع لما يتضافوا يتعلّموا من غير نشر كود.
//
// ⚠️ **ده تعريف تاني غير اللي في `jobs/whatsappRouting.js` عن قصد**، والاتنين بيجاوبوا على
// سؤالين مختلفين:
//   هنا          — «يستاهل دعم علمي؟» → الكورسات المدفوعة بس
//   whatsappRouting — «محتاج إقناع يشترك؟» → أي حساب على المنصة
// الطالب اللي في التأسيس بس بيعدّي من التاني (تذكرته بتفضل مع المتابعة) ومابيعديش من ده.
// دمج الاتنين معناه إن ١٩٣٠ طالب تأسيس يتحوّلوا فجأة لموظف الواتساب الوحيد.
//
// ⚠️ **الدعم الفني مش بيمر من هنا خالص.** أي طالب بيوصله، مشترك أو لأ — أعطال المنصة
// بتحصل لأي حد، والطالب اللي المنصة واقعة عنده مش هينفع يترفض لأنه مادفعش.

const pool = require('../config/db');

// `renew` بتتحسب زي `enroll`: تجديد الاشتراك اشتراك. `locked` لأ — دي حالة مقفولة.
// الفحص على `telegram_chat_id` لأن ده اللي البوت شايفه؛ الطالب اللي ماربطش رقمه
// بالمنصة مالوش صف هنا وبيطلع مش مشترك، وده صح — إحنا فعلًا مانعرفش إنه دفع.
const SUBSCRIBED_SQL = `EXISTS (
  SELECT 1
  FROM tafra_students s
  JOIN tafra_enrollments e
    ON e.tafra_student_id = s.tafra_student_id
   AND e.enrollment_type IN ('enroll', 'renew')
  JOIN tafra_bootcamps b
    ON b.tafra_bootcamp_id = e.tafra_bootcamp_id
   AND b.grants_support
  WHERE s.telegram_chat_id = $1
)`;

// **بترجّع `true` لو الاستعلام فشل.** الخطأ هنا معناه إن القاعدة واقعة، والطالب الدافع
// اللي بيتحرم من التيم العلمي وقت عطل عندنا أسوأ من طالب مجاني شاف الزرار دقيقة.
// الفشل بيتسجّل عشان مايعديش ساكت.
async function isSubscribedStudent(chatId) {
  if (!chatId) return false;
  try {
    const { rows } = await pool.query(`SELECT ${SUBSCRIBED_SQL} AS subscribed`, [chatId]);
    return Boolean(rows[0]?.subscribed);
  } catch (error) {
    console.error(`❌ Failed to check the subscription of chat ${chatId}:`, error.message);
    return true;
  }
}

module.exports = { isSubscribedStudent, SUBSCRIBED_SQL };
