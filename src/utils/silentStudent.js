const { REACHED_CONDITION_SQL } = require('./callOutcomes');

// ---------- "مردش من أسبوع" — الطالب اللي فضل أسبوع كامل من غير أي رد على رسايلنا ----------
//
// اللون البنفسجي في قايمة التذاكر وفي المتابعة التليفونية. المعنى مختلف عن الأزرق والأحمر
// **في الاتجاه**: الأزرق والأحمر عن رسالة من الطالب مستنية مننا، والبنفسجي عن رسالة مننا
// مستنية منه — يعني الكورة عنده هو، وعدّى أسبوع وهو ساكت.
//
// الشرط: فيه رسالة مننا اتبعتت **بعد** آخر رسالة واردة منه، وعدّى عليها أكتر من أسبوع. الصياغة
// دي بتغطي الحالتين اللي المستخدم قصدهما: اللي مردّش خالص من أول رسالة، واللي كان بيرد وبعدين
// سكت بعد آخر رد بعتناه له.
//
// **الإرسال الجماعي مستبعد** (broadcast_recipient_id) لنفس السبب المكتوب عند NEVER_REPLIED_SQL:
// الحملة بتروح لمئات الطلاب مرة واحدة ومالهاش علاقة بأي حد فيهم، فلو حسبناها "رسالة مننا" كانت
// حملة واحدة هتلوّن نص القاعدة بنفسجي بعد أسبوع — واللون يفضى من معناه.
//
// رسالة الترحيب **محسوبة** عن قصد: طالب دخل البوت، وصله الترحيب، وعدّى أسبوع من غير ما ينطق —
// ده بالظبط الطالب اللي المتابعة محتاجة تشوفه، مش استثناء منه.
//
// التذاكر المكتملة والمغلقة مستبعدة: الإقفال بيحصل عادةً بعد رد من موظف، يعني آخر رسالة مننا —
// فمن غير الاستبعاد ده كل تذكرة اتقفلت من أسبوع كانت هتطلع بنفسجي، وهي مالهاش أي رد مستني أصلًا.
const SILENT_AFTER_DAYS = 7;

// بيعتمد على alias الـ contacts باسم c و alias الـ tickets باسم t — الاتنين موجودين في استعلامات
// التذاكر والمتابعة وطلاب المنصة. في المتابعة الجوين على الاتنين LEFT، فطالب من غير تذكرة بيطلع
// FALSE مش NULL (الـ EXISTS بترجع FALSE لما t.id تبقى NULL)
const SILENT_WEEK_SQL = `(
  COALESCE(t.status, '') NOT IN ('resolved', 'closed')
  AND EXISTS (
    SELECT 1 FROM support_messages sm
    WHERE sm.ticket_id = t.id
      AND sm.deleted_at IS NULL
      AND sm.broadcast_recipient_id IS NULL
      AND sm.sent_at < NOW() - INTERVAL '${SILENT_AFTER_DAYS} days'
      AND sm.sent_at > COALESCE((
        SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id
      ), '-infinity'::timestamptz)
  )
)`;

// ---------- "مردش على التليفون من أسبوع" ----------
//
// النسخة التليفونية من اللي فوق: اتصلنا بيه في آخر أسبوع، ومفيش ولا مكالمة وصلنا فيها له.
// الشرطين لازم يبقوا مع بعض — طالب مااتصلناش بيه أصلًا مش "مردّش"، هو ببساطة ماتجرّبش.
//
// معنى "وصلنا له" جاي من utils/callOutcomes.js مش مكتوب هنا، عشان لو الأدمن ضاف نتيجة جديدة
// أو غيّر التصنيف، الفلتر ده يتغيّر معاه لوحده. "رقم غير صحيح" مستبعد من الوصول هناك عن قصد،
// فالطالب اللي رقمه غلط بيطلع هنا — وده صح: هو فعلًا محصلش معاه تواصل، والسبب محتاج تصحيح بيانات.
//
// بيعتمد على alias الـ tafra_students باسم s — موجود في استعلامات المتابعة وطلاب المنصة
// وصندوق الدعم (عن طريق STUDENT_FILTER_JOIN_SQL)
const SILENT_CALLS_WEEK_SQL = `(
  EXISTS (
    SELECT 1 FROM call_logs cl
    WHERE cl.tafra_student_id = s.tafra_student_id
      AND cl.called_at > NOW() - INTERVAL '${SILENT_AFTER_DAYS} days'
  )
  AND NOT EXISTS (
    SELECT 1 FROM call_logs cl
    LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
    WHERE cl.tafra_student_id = s.tafra_student_id
      AND cl.called_at > NOW() - INTERVAL '${SILENT_AFTER_DAYS} days'
      AND ${REACHED_CONDITION_SQL}
  )
)`;

module.exports = { SILENT_WEEK_SQL, SILENT_CALLS_WEEK_SQL, SILENT_AFTER_DAYS };
