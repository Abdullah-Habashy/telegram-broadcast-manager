const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const ticketsController = require('../controllers/tickets.controller');
const teamsController = require('../controllers/teams.controller');
const voiceController = require('../controllers/voice.controller');
const { MAX_BYTES: VOICE_MAX_BYTES } = require('../utils/voiceNote');
const pdfAttachment = require('../utils/pdfAttachment');
const { requireAuthApi, requireTicketsAccessApi, requireAdminApi } = require('../middleware/requireAuth');

const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'support');
fs.mkdirSync(uploadDir, { recursive: true });
// مرفق الرد: صورة أو ملف PDF. **حقلين منفصلين مش حقل واحد** — الحدود والصيغ
// المسموحة مختلفة، والاسم بيقول للكنترولر يبعت بأنهي طريقة من غير ما يخمّن من الامتداد
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      const extension = file.fieldname === 'file'
        ? '.pdf'
        : (file.mimetype === 'image/png' ? '.png' : '.jpg');
      // **الاسم على القرص UUID مش اسم اللي رفعه.** الاسم الأصلي بيتخزّن في القاعدة للعرض بس
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  }),
  // **الحد الواحد ده حد الـPDF، والصورة ليها حد أصغر بيتفحص في الكنترولر.** multer
  // بياخد حد واحد للنسخة كلها، وتليجرام مابياخدش صورة أكبر من ١٠ ميجا في sendPhoto —
  // فالحد الأصغر لازم يتفحص بعد الرفع، ورسالته بتقول "الصورة" مش "الملف"
  limits: { fileSize: pdfAttachment.MAX_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (file.fieldname === 'file') {
      const isPdf = file.mimetype === pdfAttachment.MIME || /\.pdf$/i.test(file.originalname || '');
      if (!isPdf) return callback(new Error('مسموح بملفات PDF فقط'));
      return callback(null, true);
    }
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      return callback(new Error('مسموح بصور JPG وPNG فقط'));
    }
    callback(null, true);
  },
});

// **رسالة الرفض لازم توصل.** multer بيرمي الخطأ زي أي خطأ تاني فبيروح للمعالج العام في
// `server.js` ويرجّع ٥٠٠ "حصل خطأ في السيرفر" — والموظف مش عارف إن ملفه كبير ولا إن
// صيغته غلط، ومع مرفق بيوصل ٢٠ ميجا احتمال الوصول للحد بيزيد
function reportUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'المرفق أكبر من ٢٠ ميجا. صغّره أو قسّمه.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'ابعت مرفق واحد بس في الرسالة.' });
    }
    return res.status(400).json({ error: 'مشكلة في رفع المرفق — جرّب تاني.' });
  }
  if (err && err.message) return res.status(400).json({ error: err.message });
  return next(err);
}

// رفع التسجيلات الصوتية — منفصل عن رفع الصور: الصيغ مختلفة والحدود مختلفة، والامتداد بيتاخد
// من نوع المحتوى عشان ffmpeg يعرف يقرا الحاوية صح
const voiceUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      const extension = {
        'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a',
        'audio/mpeg': '.mp3', 'audio/x-m4a': '.m4a', 'audio/aac': '.m4a',
      }[file.mimetype.split(';')[0]] || '.webm';
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: VOICE_MAX_BYTES },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype.startsWith('audio/')) return callback(new Error('الملف المرفق مش تسجيل صوتي'));
    callback(null, true);
  },
});

router.use(requireAuthApi);
router.use(requireTicketsAccessApi);
router.get('/stream', ticketsController.streamEvents);
router.get('/meta', ticketsController.getTicketMeta);
router.get('/flagged-messages', ticketsController.listFlaggedMessages);
router.post('/subtitles', ticketsController.createTicketSubtitle);
router.patch('/messages/:messageId', ticketsController.editSupportMessage);
router.delete('/messages/:messageId', ticketsController.deleteSupportMessage);
router.patch('/incoming-messages/:messageId/flag', ticketsController.flagIncomingMessage);
router.patch('/incoming-messages/:messageId/react', ticketsController.reactToIncomingMessage);
router.get('/', ticketsController.listTickets);
router.get('/ids', ticketsController.listTicketIds);
router.patch('/bulk-assign', requireAdminApi, ticketsController.bulkAssignTickets);
router.patch('/bulk-assign-by-contact', requireAdminApi, ticketsController.bulkAssignTicketsByContact);
// التيمات المتخصصة — الحضور والانصراف. **لازم تفضل فوق أي مسار /:id**: express بيطابق
// بالترتيب، ولو /:id سبقها كان هياخد "science" على إنها رقم تذكرة ويرجّع خطأ
router.get('/teams/attendance', teamsController.getAttendanceStatus);
router.post('/teams/attendance/check-in', teamsController.checkIn);
router.post('/teams/attendance/check-out', teamsController.checkOut);
router.get('/teams/on-duty', teamsController.listOnDuty);

router.get('/:id', ticketsController.getTicket);
router.post('/:id/teams/:team/transfer', teamsController.transferToTeam);
router.post('/:id/teams/return', teamsController.returnFromTeam);
router.post('/:id/voice', voiceUpload.single('voice'), voiceController.sendVoiceNote);
router.post('/:id/urgent', ticketsController.toggleTicketUrgent);

router.patch('/:id/next-follow-up-message', ticketsController.updateNextFollowUpMessage);
router.patch('/:id', ticketsController.updateTicket);
router.post(
  '/:id/reply',
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]),
  reportUploadError,
  ticketsController.replyToTicket
);
router.patch('/:id/idea', ticketsController.updateIdeaProgress);
router.get('/:id/idea-log', ticketsController.getIdeaProgressLog);
router.get('/:id/recent-exam-marks', ticketsController.getRecentExamMarks);
router.get('/:id/course-exam-marks', ticketsController.getCourseExamMarks);
router.get('/:id/lesson-views', ticketsController.getTicketLessonViews);

module.exports = router;
