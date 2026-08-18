const cron = require('node-cron');
const tafraController = require('../controllers/tafra.controller');

// بيفحص كل 15 دقيقة هل فات على آخر مزامنة ناجحة مدة الفاصل الزمني المحدد في الإعدادات
// (افتراضيًا 12 ساعة) — لو آه، يبدأ مزامنة تلقائية في الخلفية من غير تدخل يدوي
function startTafraSyncScheduler() {
  cron.schedule('*/15 * * * *', () => {
    tafraController.triggerAutoSyncIfDue().catch((error) =>
      console.error('❌ Unexpected error while checking Tafra auto-sync schedule:', error.message)
    );
    // الاختبارات لها فاصل زمني مستقل وبتتخطّى نفسها لو مزامنة الطلاب شغّالة، فبنناديها في نفس
    // الفحص من غير await — مش عايزين تأخير مزامنة الاختبارات (17 دقيقة) يعطّل فحص الطلاب
    tafraController.triggerExamAutoSyncIfDue().catch((error) =>
      console.error('❌ Unexpected error while checking Tafra exam auto-sync schedule:', error.message)
    );
  });
  console.log('✅ Tafra auto-sync scheduler started; checking students and exams every 15 minutes.');
}

module.exports = { startTafraSyncScheduler };
