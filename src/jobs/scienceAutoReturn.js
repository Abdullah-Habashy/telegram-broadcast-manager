const cron = require('node-cron');
const pool = require('../config/db');

// إرجاع التذاكر من التيم العلمي لوحدها بعد نص ساعة سكوت.
//
// الشرط مش مجرد "عدّى نص ساعة": لازم يكون **الموظف العلمي صاحب آخر رسالة**. لو الطالب بعت
// سؤال والتيم لسه ما ردّش، السكوت ده مش معناه إن الشغل خلص — معناه إن فيه سؤال واقف، وإرجاعه
// تلقائيًا كان هيضيّعه من عند اللي المفروض يجاوبه. في الحالة دي التذكرة بتفضل خضرا عنده.
const RETURN_AFTER_MINUTES = 30;

// آخر رسالة في المحادثة (في أي اتجاه) لازم تكون صادرة من الموظف العلمي اللي ماسك التذكرة،
// وعدّى عليها المدة. بنقارن بـ science_since كمان عشان تذكرة اتحوّلت ومحصلش فيها ولا رسالة
// أصلًا ترجع برضه بدل ما تعلّق للأبد
const DUE_TICKETS_SQL = `
  SELECT t.id, t.science_agent_id, u.name AS agent_name
  FROM tickets t
  JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN users u ON u.id = t.science_agent_id
  LEFT JOIN LATERAL (
    SELECT MAX(im.received_at) AS at FROM incoming_messages im WHERE im.contact_id = c.id
  ) last_in ON true
  LEFT JOIN LATERAL (
    SELECT MAX(sm.sent_at) AS at FROM support_messages sm
    WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL AND sm.sent_by = t.science_agent_id
  ) last_science ON true
  WHERE t.science_agent_id IS NOT NULL
    AND GREATEST(
      COALESCE(last_in.at, '-infinity'::timestamptz),
      COALESCE(last_science.at, '-infinity'::timestamptz),
      t.science_since
    ) < NOW() - ($1 * INTERVAL '1 minute')
    AND (
      -- الموظف العلمي رد وبعدها سكوت: الشغل خلص، ترجع
      (last_science.at IS NOT NULL
       AND last_science.at >= COALESCE(last_in.at, '-infinity'::timestamptz))
      -- أو اتحوّلت ومحصلش فيها أي رسالة خالص من ساعتها — تحويل بالغلط أو الطالب مكملش
      OR (last_science.at IS NULL
          AND COALESCE(last_in.at, '-infinity'::timestamptz) < t.science_since)
    )
`;

async function returnIdleScienceTickets() {
  const { rows } = await pool.query(DUE_TICKETS_SQL, [RETURN_AFTER_MINUTES]);
  if (!rows.length) return 0;

  // الشرط بيتكرر في جملة التحديث نفسها عن طريق قايمة المعرّفات: لو الطالب بعت رسالة بين
  // الاستعلام والتحديث، science_since مابيتغيرش لكن التذكرة بقت مستنية رد — فبنعيد التأكد
  // إن الموظف العلمي لسه هو صاحب آخر رسالة قبل ما نرجّعها
  const ids = rows.map((row) => row.id);
  const updated = await pool.query(
    `UPDATE tickets t SET science_agent_id = NULL, science_since = NULL, updated_at = NOW()
     WHERE t.id = ANY($1::int[]) AND t.science_agent_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM incoming_messages im
         JOIN contacts c ON c.id = im.contact_id
         WHERE c.id = t.contact_id AND im.received_at > t.science_since
           AND im.received_at > COALESCE((
             SELECT MAX(sm.sent_at) FROM support_messages sm
             WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL AND sm.sent_by = t.science_agent_id
           ), '-infinity'::timestamptz)
       )
     RETURNING t.id`,
    [ids]
  );
  if (updated.rowCount) {
    console.log(`🧪 Returned ${updated.rowCount} ticket(s) from the science team after ${RETURN_AFTER_MINUTES} idle minutes.`);
  }
  return updated.rowCount;
}

function startScienceAutoReturn() {
  // كل ٥ دقايق: دقة كافية لمهلة نص ساعة، ومن غير استعلام كل دقيقة على الفاضي
  cron.schedule('*/5 * * * *', () => {
    returnIdleScienceTickets().catch((err) =>
      console.error('❌ Failed to auto-return science tickets:', err.message)
    );
  });
  console.log(`✅ Science auto-return started; returns tickets idle for ${RETURN_AFTER_MINUTES} minutes.`);
}

module.exports = { startScienceAutoReturn, returnIdleScienceTickets, RETURN_AFTER_MINUTES };
