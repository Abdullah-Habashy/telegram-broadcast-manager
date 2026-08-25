const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const ticketsController = require('../controllers/tickets.controller');
const scienceController = require('../controllers/science.controller');
const { requireAuthApi, requireTicketsAccessApi, requireAdminApi } = require('../middleware/requireAuth');

const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'support');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      const extension = file.mimetype === 'image/png' ? '.png' : '.jpg';
      callback(null, `${crypto.randomUUID()}${extension}`);
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
// التيم العلمي — الحضور والانصراف. **لازم تفضل فوق أي مسار /:id**: express بيطابق
// بالترتيب، ولو /:id سبقها كان هياخد "science" على إنها رقم تذكرة ويرجّع خطأ
router.get('/science/attendance', scienceController.getAttendanceStatus);
router.post('/science/attendance/check-in', scienceController.checkIn);
router.post('/science/attendance/check-out', scienceController.checkOut);
router.get('/science/on-duty', scienceController.listOnDuty);

router.get('/:id', ticketsController.getTicket);
router.post('/:id/science/transfer', scienceController.transferToScience);
router.post('/:id/science/return', scienceController.returnFromScience);
router.post('/:id/urgent', ticketsController.toggleTicketUrgent);

router.patch('/:id/next-follow-up-message', ticketsController.updateNextFollowUpMessage);
router.patch('/:id', ticketsController.updateTicket);
router.post('/:id/reply', upload.single('image'), ticketsController.replyToTicket);
router.patch('/:id/idea', ticketsController.updateIdeaProgress);
router.get('/:id/idea-log', ticketsController.getIdeaProgressLog);
router.get('/:id/recent-exam-marks', ticketsController.getRecentExamMarks);
router.get('/:id/course-exam-marks', ticketsController.getCourseExamMarks);
router.get('/:id/lesson-views', ticketsController.getTicketLessonViews);

module.exports = router;
