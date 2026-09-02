const cron = require('node-cron');
const pool = require('../config/db');
const { TEAMS } = require('../utils/teams');

// إرجاع التذاكر من التيم المتخصص لوحدها بعد نص ساعة سكوت.
//
// ⛔ **مقفول دلوقتي — بقرار صاحب المشروع: رجوع التذكرة يدوي بس.**
// كل التيمات بقت `idleReturn: false` في `utils/teams.js`، فالقايمة تحت بتطلع فاضية
// والجدولة مابتشتغلش أصلًا. الكود سايب مش متشال عشان الرجوع يبقى قلب قيمة واحدة لتيم
// واحد — والمنطق ده اتصلّح فيه باجين قبل كده، إعادة كتابته من الأول أغلى من إبقائه.
//
// **الأثر اللي اتقبل مع القرار:** التذكرة المحوّلة لمتخصص ساكت بتفضل عنده لحد ما حد
// يرجّعها بإيده. الميزة دي اتعملت أصلًا عشان "سؤال الطالب اللي محدش رد عليه كان بيفضل
// عند المتخصص للأبد" — والحالة دي رجعت ممكنة عن قصد.
//
// **والانصراف لسه بيرجّع التذاكر** (`teams.controller.js` → `checkOut`): موظف مشي
// وسايب تذاكر معناه سؤال واقف عند حد مش موجود. ده مسار تاني مش مرتبط بالوظيفة دي.
//
// القاعدة القديمة لو رجعت: سكون كامل في أي اتجاه بيصفّر العدّاد، وأول ما تعدّي المدة
// التذكرة بترجع للمتابعة.
const RETURN_AFTER_MINUTES = 30;

// التيمات اللي بترجع بالسكوت. **فاضية دلوقتي** — ولو رجعت قيمة واحدة لـtrue، الوظيفة
// بتشتغل عليها لوحدها من غير أي تغيير تاني
const IDLE_RETURN_TEAMS = Object.values(TEAMS).filter((t) => t.idleReturn).map((t) => t.key);

// آخر نشاط = أحدث واحدة في: رسالة واردة من الطالب، رسالة صادرة من أي موظف، أو لحظة التحويل
// نفسها. الأخيرة مهمة عشان تذكرة اتحوّلت ومحصلش فيها ولا رسالة أصلًا ترجع برضه بدل ما تعلّق.
//
// **رسايل الحملات مستثناة** (broadcast_recipient_id): إرسال جماعي وصل للطالب مش محادثة معاه،
// وحسابه كنشاط كان هيخلي أي حملة تصفّر عدّاد كل التذاكر المحوّلة في نفس اللحظة.
const LAST_ACTIVITY_SQL = `
  GREATEST(
    COALESCE((SELECT MAX(im.received_at) FROM incoming_messages im
              WHERE im.contact_id = t.contact_id), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(sm.sent_at) FROM support_messages sm
              WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL
                AND sm.broadcast_recipient_id IS NULL), '-infinity'::timestamptz),
    t.transfer_since
  )`;

const DUE_TICKETS_SQL = `
  SELECT t.id, t.transfer_agent_id, u.name AS agent_name
  FROM tickets t
  LEFT JOIN users u ON u.id = t.transfer_agent_id
  WHERE t.transfer_agent_id IS NOT NULL
    AND t.transfer_team = ANY($2::text[])
    AND ${LAST_ACTIVITY_SQL} < NOW() - ($1 * INTERVAL '1 minute')
`;

// نفس الشرط بيتعاد في جملة التحديث: لو وصلت رسالة بين الاستعلام والتحديث، التذكرة مابقتش
// ساكتة وماينفعش ترجع. القايمة بتحدد **مين نفحص**، والشرط بيحدد **مين يرجع فعلًا**
const RETURN_SQL = `
  UPDATE tickets t
  SET transfer_agent_id = NULL, transfer_team = NULL, transfer_since = NULL, updated_at = NOW()
  WHERE t.id = ANY($1::int[])
    AND t.transfer_agent_id IS NOT NULL
    AND ${LAST_ACTIVITY_SQL} < NOW() - ($2 * INTERVAL '1 minute')
  RETURNING t.id
`;

async function returnIdleTeamTickets() {
  // باراميترين بالظبط: المهلة وقايمة التيمات. كان فيه تالت مبعوت وماستخدمش في نص الاستعلام،
  // وبوستجرس بيرفض الاستعلام كله بـ "could not determine data type of parameter" — الوظيفة
  // كانت بترمي كل ٥ دقايق من غير ما ترجّع ولا تذكرة
  const { rows } = await pool.query(DUE_TICKETS_SQL, [RETURN_AFTER_MINUTES, IDLE_RETURN_TEAMS]);
  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const updated = await pool.query(RETURN_SQL, [ids, RETURN_AFTER_MINUTES]);
  if (updated.rowCount) {
    console.log(`🧪 Returned ${updated.rowCount} ticket(s) from specialist teams after ${RETURN_AFTER_MINUTES} silent minutes.`);
  }
  return updated.rowCount;
}

function startTeamAutoReturn() {
  // **مافيش تيم بيرجع بالسكوت؟ مافيش جدولة.** الاستعلام كان هيمشي كل ٥ دقايق على
  // قايمة فاضية ويرجع بلا شيء — والسطر في اللوج كان هيقول إن الإرجاع التلقائي شغّال
  // وهو مقفول، وده أسوأ من إنه مايتقالش
  if (!IDLE_RETURN_TEAMS.length) {
    console.log('⛔ Team auto-return is off — tickets only leave a specialist when someone returns them.');
    return;
  }

  // كل ٥ دقايق: دقة كافية لمهلة نص ساعة، ومن غير استعلام كل دقيقة على الفاضي
  cron.schedule('*/5 * * * *', () => {
    returnIdleTeamTickets().catch((err) =>
      console.error('❌ Failed to auto-return team tickets:', err.message)
    );
  });
  console.log(`✅ Team auto-return started; returns tickets silent for ${RETURN_AFTER_MINUTES} minutes.`);
}

module.exports = { startTeamAutoReturn, returnIdleTeamTickets, RETURN_AFTER_MINUTES };
