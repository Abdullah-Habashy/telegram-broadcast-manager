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
