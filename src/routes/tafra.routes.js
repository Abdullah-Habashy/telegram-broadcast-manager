const express = require('express');
const controller = require('../controllers/tafra.controller');
const { requireAuthApi, requireAdminApi } = require('../middleware/requireAuth');

const router = express.Router();

// متاح لأي مستخدم مسجّل دخول (مش بس الأدمن) — شاشة المتابعة التليفونية للموظفين محتاجاه
// عشان يملى خيارات الفلاتر (الصف/الحالة/الباب/الاختبار) في قايمتهم هم، من غير ما يشوفوا باقي شاشات طفرة
router.get('/student-filters', requireAuthApi, controller.getStudentFilters);

router.use(requireAdminApi);
router.get('/status', controller.getStatus);
router.get('/students', controller.listStudents);
router.get('/students/ids', controller.listStudentContactIds);
router.get('/new-bot-info', controller.getNewBotInfo);
router.get('/new-bot-contacts', controller.listNewBotContacts);
router.get('/new-bot-contacts/ids', controller.listNewBotContactIds);
router.post('/new-bot-broadcast', controller.sendNewBotBroadcast);
router.post('/new-bot-reachability-sync', controller.syncNewBotReachability);
router.get('/new-bot-reachability-sync-status', controller.getNewBotReachabilitySyncStatus);
router.get('/follow-up-bot-log', controller.getFollowUpBotStartLog);
router.get('/new-bot-webhook-status', controller.getNewBotWebhookStatus);
router.post('/new-bot-webhook-claim', controller.claimNewBotWebhook);
router.post('/new-bot-webhook-release', controller.releaseNewBotWebhook);
router.get('/students/export', controller.exportStudentsReport);
router.post('/credentials', controller.saveCredentials);
router.post('/sync', controller.syncStudents);
router.post('/sync-enrollments', controller.syncEnrollments);
router.post('/sync-selected-bootcamps', controller.syncSelectedBootcamps);
router.get('/selective-sync-status', controller.getSelectiveSyncStatus);
router.post('/sync-bootcamps', controller.syncBootcampNames);
router.get('/exam-sync-status', controller.getExamSyncStatus);
router.post('/sync-exams', controller.syncExams);

module.exports = router;
