const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const controller = require('../controllers/tafra.controller');
const { requireAuthApi, requireAdminApi } = require('../middleware/requireAuth');

const router = express.Router();

// صور رسايل بوت طفرة — بتترفع مؤقتًا وبتتمسح بعد الإرسال على طول (مفيش سجل إرسال بيشاور
// عليها زي broadcasts.image_path، فلو سبناها هتتراكم على القرص من غير ما حد يشيلها)
const newBotUploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(newBotUploadDir, { recursive: true });
const uploadNewBotImage = multer({
  storage: multer.diskStorage({
    destination: newBotUploadDir,
    filename: (req, file, callback) => {
      const extension = file.mimetype === 'image/png' ? '.png' : '.jpg';
      callback(null, `newbot-${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      return callback(new Error('مسموح بصور JPG وPNG فقط'));
    }
    callback(null, true);
  },
});

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
router.post('/new-bot-broadcast', uploadNewBotImage.single('image'), controller.sendNewBotBroadcast);
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
