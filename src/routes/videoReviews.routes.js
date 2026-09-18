const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const controller = require('../controllers/videoReviews.controller');
const { requireQuizAccessApi } = require('../middleware/requireAuth');

// نفس مجلد وحدود صور الأسئلة والإرسال الجماعي — مفيش سبب لمسار تاني بقواعد تانية
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const EXTENSIONS = { 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg' };

const uploadScreenshot = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      callback(null, `video-review-${crypto.randomUUID()}${EXTENSIONS[file.mimetype] || '.jpg'}`);
    },
  }),
  // **١٥ ميجا مش ١٠**: دي لقطة شاشة PNG من فيديو 1080p أو 4K، وده بيعدّي العشرة بسهولة.
  // والصورة هنا هي نص الفايدة — المونتير بيشوف الغلطة قبل ما يفتح الملف
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    // webp مقبول مع jpg وpng: أداة القص في ويندوز وبعض المتصفحات بتحفظ بيه
    if (!EXTENSIONS[file.mimetype]) return callback(new Error('مسموح بصور JPG وPNG وWEBP فقط'));
    callback(null, true);
  },
});

// **نفس صلاحية الاختبارات بالظبط** (الأدمن + التيم العلمي + الدعم الفني) — وهي نفسها
// اللي بتقرر ظهور التبويب في اللوحة. لو اتفرقوا هيبقى فيه حد شايف التبويب وبيتردّ عليه ٤٠٣
router.use(requireQuizAccessApi);

// رسالة رفض الرفع لازم توصل للموظف. من غير المعالج ده multer بيرمي زي أي خطأ تاني
// فبيروح للمعالج العام في server.js ويرجّع ٥٠٠ "حصل خطأ في السيرفر"
function reportUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'الصورة أكبر من ١٥ ميجا. صغّرها أو احفظها JPG.' });
    }
    return res.status(400).json({ error: 'مشكلة في رفع الصورة — جرّب تاني.' });
  }
  if (err && err.message) return res.status(400).json({ error: err.message });
  return next(err);
}

// الترتيب هنا مقصود: كل المسارات الثابتة قبل أي مسار فيه :id
router.post('/screenshot', uploadScreenshot.single('screenshot'), reportUploadError, controller.uploadScreenshot);
router.get('/export', controller.exportNotes);

router.get('/books', controller.listBooks);
router.post('/books', controller.createBook);
router.put('/books/:id', controller.updateBook);
router.delete('/books/:id', controller.deleteBook);

// الملاحظة بتتعدّل بمعرّفها لوحده — الموظف بيكون فاتح شاشة فيديو واحد، وتمرير معرّف
// الفيديو كمان كان هيدّي مسار أطول من غير أي فايدة
router.put('/notes/:noteId', controller.updateNote);
router.post('/notes/:noteId/status', controller.setNoteStatus);
router.delete('/notes/:noteId', controller.deleteNote);

router.get('/videos', controller.listVideos);
router.post('/videos', controller.createVideo);
router.get('/videos/:id/notes', controller.listNotes);
// ملف ماركرز للوحة بريمير (tools/premiere-markers-panel)
router.get('/videos/:id/markers', controller.exportMarkers);
router.post('/videos/:id/notes', controller.createNote);
router.put('/videos/:id', controller.updateVideo);
router.delete('/videos/:id', controller.deleteVideo);

module.exports = router;
