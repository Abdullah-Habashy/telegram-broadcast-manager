const cron = require('node-cron');
const pool = require('../config/db');
const { getNextTeamAgent } = require('../utils/ticketAssignment');

// ---------- توجيه الطلاب غير المشتركين لموظف واتساب ----------
//
// الطالب اللي دخل البوت وحسابه مش مربوط بأي كورس مش طالب متابعة — هو حد لسه بيسأل قبل ما
// يشترك، وده شغل موظف الواتساب. التوجيه بيحصل تلقائيًا في الاتجاهين:
//   مش مشترك  → بيتحوّل لموظف واتساب
//   اشترك     → التحويل بيتشال ويرجع لفريق المتابعة
//
// **وظيفة واحدة للاتجاهين بدل ما نحشر الشرط في مسارات إنشاء التذكرة الأربعة** (start.js
// و message.js و broadcastSender.js وغيرهم). السبب مش الاختصار: بيانات الاشتراك بتيجي من
// مزامنة منفصلة، فالطالب اللي بيدوس Start قبل ما مزامنته توصل بيبان "مش مشترك" لحظة
// الإنشاء. الوظيفة دي بتشوف الحالة الحالية كل مرة، فبتصحّح نفسها لوحدها لما البيانات توصل.
//
// ⚠️ **دقة التوجيه مربوطة بمزامنة الاشتراكات مش بالوظيفة دي.** المزامنة دي كانت يدوية
// بالكامل لفترة، وقعدت ٣ أيام من غير تحديث — وكل اللي اشتركوا في التلات أيام دول فضلوا
// متحوّلين لموظف الواتساب وهم دافعين. بقت مجدولة كل ٦ ساعات
// (`tafra_enrollment_auto_sync_interval_hours`). لو التوجيه بان غلط تاني، ابدأ من
// `tafra_enrollment_sync_status.completed_at` قبل أي حاجة تانية.
//
// التحويل مش نقل ملكية: assigned_to بيفضل موظف المتابعة، فالتذكرة بتظهر عند الاتنين وكل واحد
// فيهم عنده زرار ينقلها للتاني — المرونة اللي المفروض تكون موجودة لما القاعدة تغلط في حالة.
const TEAM = 'whatsapp';

// الطالب "مشترك" لو عنده صف اشتراك من نوع enroll. مفيش حساب على المنصة أصلًا = مش مشترك
const ENROLLED_SQL = `EXISTS (
  SELECT 1
  FROM tafra_students s
  JOIN tafra_enrollments e ON e.tafra_student_id = s.tafra_student_id AND e.enrollment_type = 'enroll'
  WHERE s.telegram_chat_id = c.chat_id
)`;

// مرشحين للتحويل: مش مشتركين، ومش محوّلين لأي تيم دلوقتي (تذكرة مع التيم العلمي مثلًا
// مانلمسهاش — الموظف حوّلها بإيده وده أعلى من أي قاعدة تلقائية)
const NEEDS_ROUTING_SQL = `
  SELECT t.id FROM tickets t
  JOIN contacts c ON c.id = t.contact_id
  WHERE t.transfer_agent_id IS NULL AND NOT ${ENROLLED_SQL}
  ORDER BY t.last_message_at DESC
  LIMIT $1
`;

// اشترك وهو مع الواتساب: التحويل بيتشال ويرجع لفريق المتابعة
const NEEDS_RETURN_SQL = `
  SELECT t.id FROM tickets t
  JOIN contacts c ON c.id = t.contact_id
  WHERE t.transfer_team = '${TEAM}' AND ${ENROLLED_SQL}
`;

// دفعة محدودة كل تشغيلة: أول مرة الوظيفة تشتغل هتلاقي كل غير المشتركين المتراكمين مرة واحدة،
// والدفعة بتمنع إنها تقفل الاتصالات على الشغل الجاري. الباقي بياخد دوره في التشغيلات اللي بعدها
const BATCH_SIZE = 100;
let running = false;

async function routeUnenrolledTickets() {
  if (running) return { routed: 0, returned: 0 };
  running = true;
  try {
    const returned = await pool.query(
      `UPDATE tickets SET transfer_agent_id = NULL, transfer_team = NULL, transfer_since = NULL,
        updated_at = NOW()
       WHERE id IN (${NEEDS_RETURN_SQL}) RETURNING id`
    );

    const { rows } = await pool.query(NEEDS_ROUTING_SQL, [BATCH_SIZE]);
    let routed = 0;
    for (const row of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // الدور بيتاخد جوه ترانزاكشن زي أي توزيع تاني، عشان تشغيلتين متوازيتين مايدوش نفس الدور
        const agentId = await getNextTeamAgent(client, TEAM);
        // مفيش موظف واتساب: بنوقف الدفعة كلها. الـ break بيخرج بعد ما finally يحرّر الاتصال —
        // التحرير هنا كمان كان بيحرّره مرتين ويرمي "already been released"
        if (!agentId) { await client.query('ROLLBACK'); break; }
        const updated = await client.query(
          `UPDATE tickets SET transfer_agent_id = $2, transfer_team = $3, transfer_since = NOW(),
            updated_at = NOW()
           WHERE id = $1 AND transfer_agent_id IS NULL RETURNING id`,
          [row.id, agentId, TEAM]
        );
        await client.query('COMMIT');
        if (updated.rowCount) routed += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`❌ Failed to route ticket #${row.id} to WhatsApp:`, error.message);
      } finally {
        client.release();
      }
    }
    if (routed || returned.rowCount) {
      console.log(`💬 WhatsApp routing: ${routed} unenrolled ticket(s) routed, ${returned.rowCount} returned after enrolling.`);
    }
    return { routed, returned: returned.rowCount };
  } finally {
    running = false;
  }
}

function startWhatsappRouting() {
  // كل ٥ دقايق: الطالب الجديد بيستنى دقايق قليلة قبل ما يوصل لموظف الواتساب، وده مقبول
  // لأن رسالة الترحيب بتوصله فورًا على أي حال
  cron.schedule('*/5 * * * *', () => {
    routeUnenrolledTickets().catch((err) =>
      console.error('❌ Failed to run WhatsApp routing:', err.message)
    );
  });
  console.log('✅ WhatsApp routing started; unenrolled students go to the WhatsApp team every 5 minutes.');
}

module.exports = { startWhatsappRouting, routeUnenrolledTickets };
