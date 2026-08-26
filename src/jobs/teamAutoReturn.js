const cron = require('node-cron');
const pool = require('../config/db');
const { TEAMS } = require('../utils/teams');

// إرجاع التذاكر من التيم المتخصص لوحدها بعد نص ساعة سكوت.
//
// الشرط مش مجرد "عدّى نص ساعة": لازم يكون **الموظف المتخصص صاحب آخر رسالة**. لو الطالب بعت
// سؤال والتيم لسه ما ردّش، السكوت ده مش معناه إن الشغل خلص — معناه إن فيه سؤال واقف، وإرجاعه
// تلقائيًا كان هيضيّعه من عند اللي المفروض يجاوبه. في الحالة دي التذكرة بتفضل خضرا عنده.
const RETURN_AFTER_MINUTES = 30;

// آخر رسالة في المحادثة (في أي اتجاه) لازم تكون صادرة من الموظف المتخصص اللي ماسك التذكرة،
// وعدّى عليها المدة. بنقارن بـ transfer_since كمان عشان تذكرة اتحوّلت ومحصلش فيها ولا رسالة
// أصلًا ترجع برضه بدل ما تعلّق للأبد
// التيمات اللي بترجع بالسكوت بس — الواتساب مستثنى لأن محادثة الإقناع ممكن تفضل أيام
const IDLE_RETURN_TEAMS = Object.values(TEAMS).filter((t) => t.idleReturn).map((t) => t.key);

const DUE_TICKETS_SQL = `
  SELECT t.id, t.transfer_agent_id, u.name AS agent_name
  FROM tickets t
  JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN users u ON u.id = t.transfer_agent_id
  LEFT JOIN LATERAL (
    SELECT MAX(im.received_at) AS at FROM incoming_messages im WHERE im.contact_id = c.id
  ) last_in ON true
  LEFT JOIN LATERAL (
    SELECT MAX(sm.sent_at) AS at FROM support_messages sm
    WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL AND sm.sent_by = t.transfer_agent_id
  ) last_team ON true
  WHERE t.transfer_agent_id IS NOT NULL
    AND t.transfer_team = ANY($3::text[])
    AND GREATEST(
      COALESCE(last_in.at, '-infinity'::timestamptz),
      COALESCE(last_team.at, '-infinity'::timestamptz),
      t.transfer_since
    ) < NOW() - ($1 * INTERVAL '1 minute')
    AND (
      -- الموظف المتخصص رد وبعدها سكوت: الشغل خلص، ترجع
      (last_team.at IS NOT NULL
       AND last_team.at >= COALESCE(last_in.at, '-infinity'::timestamptz))
      -- أو اتحوّلت ومحصلش فيها أي رسالة خالص من ساعتها — تحويل بالغلط أو الطالب مكملش
      OR (last_team.at IS NULL
          AND COALESCE(last_in.at, '-infinity'::timestamptz) < t.transfer_since)
    )
`;

async function returnIdleTeamTickets() {
  const { rows } = await pool.query(DUE_TICKETS_SQL, [RETURN_AFTER_MINUTES, RETURN_AFTER_MINUTES, IDLE_RETURN_TEAMS]);
  if (!rows.length) return 0;

  // الشرط بيتكرر في جملة التحديث نفسها عن طريق قايمة المعرّفات: لو الطالب بعت رسالة بين
  // الاستعلام والتحديث، transfer_since مابيتغيرش لكن التذكرة بقت مستنية رد — فبنعيد التأكد
  // إن الموظف المتخصص لسه هو صاحب آخر رسالة قبل ما نرجّعها
  const ids = rows.map((row) => row.id);
  const updated = await pool.query(
    `UPDATE tickets t SET transfer_agent_id = NULL, transfer_team = NULL, transfer_since = NULL, updated_at = NOW()
     WHERE t.id = ANY($1::int[]) AND t.transfer_agent_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM incoming_messages im
         JOIN contacts c ON c.id = im.contact_id
         WHERE c.id = t.contact_id AND im.received_at > t.transfer_since
           AND im.received_at > COALESCE((
             SELECT MAX(sm.sent_at) FROM support_messages sm
             WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL AND sm.sent_by = t.transfer_agent_id
           ), '-infinity'::timestamptz)
       )
     RETURNING t.id`,
    [ids]
  );
  if (updated.rowCount) {
    console.log(`🧪 Returned ${updated.rowCount} ticket(s) from specialist teams after ${RETURN_AFTER_MINUTES} idle minutes.`);
  }
  return updated.rowCount;
}

function startTeamAutoReturn() {
  // كل ٥ دقايق: دقة كافية لمهلة نص ساعة، ومن غير استعلام كل دقيقة على الفاضي
  cron.schedule('*/5 * * * *', () => {
    returnIdleTeamTickets().catch((err) =>
      console.error('❌ Failed to auto-return team tickets:', err.message)
    );
  });
  console.log(`✅ Team auto-return started; returns tickets idle for ${RETURN_AFTER_MINUTES} minutes.`);
}

module.exports = { startTeamAutoReturn, returnIdleTeamTickets, RETURN_AFTER_MINUTES };
