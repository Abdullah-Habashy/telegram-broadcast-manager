const cron = require('node-cron');
const crypto = require('crypto');
const pool = require('../config/db');
const { TafraReadOnlyClient } = require('../integrations/tafraClient');
const { getCredentials, saveEnrollmentPage } = require('../controllers/tafra.controller');

let running = false;

// بيسحب اشتراكات الكورس المحدد بس (مش كل الأبواب) مباشرة من منصة طفرة، عشان الإسناد التلقائي كل
// 10 دقايق يشتغل على بيانات حديثة فعلًا مش على نسخة محلية ممكن تكون قديمة لو محدش عمل تحديث يدوي
async function pullBootcampEnrollmentsLive(bootcampId) {
  const credentials = await getCredentials();
  if (!credentials) return false;
  const tafra = new TafraReadOnlyClient(credentials.identifier, credentials.password);
  const first = await tafra.getBootcampEnrollmentsPage(bootcampId, 1);
  const totalPages = Number(first.data?.meta?.last_page || 1);
  for (let page = 1; page <= totalPages; page += 1) {
    const response = page === 1 ? first : await tafra.getBootcampEnrollmentsPage(bootcampId, page);
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    await saveEnrollmentPage(pool, bootcampId, rows);
    if (page < totalPages) await tafra.waitForRateLimit();
  }
  return true;
}

// قاعدة دائمة: أي طالب جديد يشترك في أي كورس من الكورسات المحددة وملوش إسناد في متابعة المكالمات
// لسه، بيتوزع بالتبادل على الموظفين المختارين في الإعدادات — نفس فكرة التوزيع بالتبادل للتذاكر.
// الطالب اللي اتسند مرة (يدوي أو تلقائي) مايتحركش تاني (ON CONFLICT DO NOTHING)، فمفيش طالب بياخد
// أكتر من موظف حتى لو مشترك في أكتر من كورس من الكورسات المستهدفة
async function runCallAutoAssign() {
  if (running) return;
  running = true;
  try {
    const configResult = await pool.query('SELECT * FROM call_auto_assign_config WHERE id = 1');
    const config = configResult.rows[0];
    if (!config || !config.enabled || !config.bootcamp_ids?.length || !config.employee_ids?.length) return;

    for (const bootcampId of config.bootcamp_ids) {
      try {
        await pullBootcampEnrollmentsLive(bootcampId);
      } catch (pullError) {
        console.error(`❌ Failed to pull live enrollments for auto-assign bootcamp #${bootcampId}:`, pullError.message);
        // نكمل باقي الكورسات المحددة حتى لو كورس واحد فشل سحبه، أحسن من إلغاء التشغيلة كلها
      }
    }

    const eligibleResult = await pool.query(
      'SELECT id FROM users WHERE id = ANY($1::int[]) AND is_active = TRUE ORDER BY id ASC',
      [config.employee_ids]
    );
    const eligible = eligibleResult.rows.map((row) => row.id);
    if (!eligible.length) return;

    // لكل طالب مطابق لأكتر من كورس من الكورسات المستهدفة، بناخد أقدم اشتراك بينهم بس (DISTINCT ON)
    // عشان نتجنّب معالجة نفس الطالب أكتر من مرة، وترتيب الطابور نفسه بيتحدد بتاريخ أقدم اشتراك مطابق
    const pendingResult = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (s.tafra_student_id) s.tafra_student_id, en.tafra_bootcamp_id, en.enrolled_at
         FROM tafra_students s
         JOIN tafra_enrollments en ON en.tafra_student_id = s.tafra_student_id
           AND en.tafra_bootcamp_id = ANY($1) AND en.enrollment_type = 'enroll'
         WHERE NOT EXISTS (SELECT 1 FROM student_call_assignments sca WHERE sca.tafra_student_id = s.tafra_student_id)
         ORDER BY s.tafra_student_id, en.enrolled_at ASC NULLS LAST
       ) pending
       ORDER BY enrolled_at ASC NULLS LAST, tafra_student_id ASC`,
      [config.bootcamp_ids]
    );
    if (!pendingResult.rows.length) return;

    let pointerIndex = eligible.indexOf(config.last_assigned_user_id);
    let assignedCount = 0;
    const batchId = crypto.randomUUID();

    for (const row of pendingResult.rows) {
      const candidateIndex = (pointerIndex + 1) % eligible.length;
      const nextAssignee = eligible[candidateIndex];
      const insertResult = await pool.query(
        `INSERT INTO student_call_assignments (tafra_student_id, assigned_to, assigned_by, assigned_at)
         VALUES ($1, $2, NULL, NOW()) ON CONFLICT (tafra_student_id) DO NOTHING RETURNING tafra_student_id`,
        [row.tafra_student_id, nextAssignee]
      );
      if (!insertResult.rowCount) continue;
      pointerIndex = candidateIndex;
      assignedCount += 1;
      await pool.query(
        `INSERT INTO call_assignment_log (batch_id, tafra_student_id, action, assigned_to, previous_assigned_to, assigned_by, filters)
         VALUES ($1, $2, 'assign', $3, NULL, NULL, $4)`,
        [batchId, row.tafra_student_id, nextAssignee, JSON.stringify({ auto: true, bootcamp_id: row.tafra_bootcamp_id })]
      );
    }

    if (assignedCount) {
      await pool.query(
        'UPDATE call_auto_assign_config SET last_assigned_user_id = $1, updated_at = NOW() WHERE id = 1',
        [eligible[pointerIndex]]
      );
      console.log(`✅ تم إسناد ${assignedCount} طالب تلقائيًا بالتبادل لمتابعة المكالمات`);
    }
  } catch (error) {
    console.error('❌ Failed to run call auto-assign job:', error.message);
  } finally {
    running = false;
  }
}

function startCallAutoAssign() {
  cron.schedule('*/10 * * * *', () => {
    runCallAutoAssign().catch((err) => console.error('❌ Call auto-assign job crashed:', err.message));
  });
  console.log('✅ Call auto-assign scheduler started; checking every 10 minutes.');
}

module.exports = { startCallAutoAssign, runCallAutoAssign };
