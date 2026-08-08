require('dotenv').config();
const pool = require('../config/db');
const controller = require('../controllers/tafra.controller');

async function main() {
  let started = false;
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      if (this.statusCode >= 400) throw new Error(payload.error || 'تعذر بدء تحديث الاشتراكات');
      started = true;
      console.log(payload.message || 'بدأ تحديث الاشتراكات');
    },
  };
  await controller.syncEnrollments({}, response);
  if (!started) throw new Error('لم يبدأ تحديث الاشتراكات');

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = await pool.query('SELECT * FROM tafra_enrollment_sync_status WHERE id=1');
    const status = result.rows[0];
    console.log(`الحالة: ${status.status} — الأبواب: ${status.current_bootcamp}/${status.total_bootcamps} — السجلات: ${status.synced_enrollments}`);
    if (status.status !== 'running') {
      if (status.status !== 'completed') throw new Error(status.error_message || 'فشل تحديث الاشتراكات');
      break;
    }
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
