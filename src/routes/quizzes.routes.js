const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const controller = require('../controllers/quizzes.controller');
const { requireQuizAccessApi, requireAdminApi } = require('../middleware/requireAuth');

// نفس مجلد ونفس حدود صور الإرسال الجماعي — مفيش سبب لمسار تاني بقواعد تانية
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const uploadQuizImage = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      const extension = file.mimetype === 'image/png' ? '.png' : '.jpg';
      callback(null, `quiz-${crypto.randomUUID()}${extension}`);
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

// الأدمن + التيم العلمي + الدعم الفني. نفس الشرط بالظبط اللي بيقرر ظهور التبويب في اللوحة
// (utils/teams.js) — لو اتفرقوا هيبقى فيه حد شايف التبويب وبيتردّ عليه ٤٠٣.
// الصفحة العامة للطالب متسجّلة في server.js على /q/:ref برّه المسارات المحمية دي
router.use(requireQuizAccessApi);

// ملف الأسئلة بيتقرا من الذاكرة — محتاجين نصه بس، ومفيش سبب نكتبه على القرص.
//
// **٢٥ ميجا مش ٥.** الحد القديم كان مبني على إن الملف نصّي، و"الأكبر منه غالبًا صور" —
// والصور بقت هي المطلوبة. ورقة أسئلة بصور من كاميرا موبايل بتوصل ١٥–٣٠ ميجا بسهولة،
// واللي فوق كده مستند تاني مش ورقة أسئلة
const uploadQuizDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const isDocx = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || /\.docx$/i.test(file.originalname || '');
    if (!isDocx) return callback(new Error('لازم يكون ملف Word بصيغة .docx'));
    callback(null, true);
  },
});

// قبل /:id عن قصد: "grade-preview" مش رقم، بس ترتيب المسارات أوضح من الاعتماد على ده
// **رسالة الرفض لازم توصل.** multer بيرمي الخطأ زي أي خطأ تاني، فبيروح للمعالج العام
// في server.js ويرجع ٥٠٠ "حصل خطأ في السيرفر" — والموظف مش عارف إن ملفه كبير ولا إن
// صيغته غلط. ومع رفع الحد لـ٢٥ ميجا، احتمال الوصول للحد **بيزيد** مش بيقل
function reportUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'الملف أكبر من ٢٥ ميجا. صغّر الصور اللي جواه أو قسّمه لملفين.' });
    }
    return res.status(400).json({ error: 'مشكلة في رفع الملف — جرّب تاني.' });
  }
  if (err && err.message) return res.status(400).json({ error: err.message });
  return next(err);
}

router.post('/image', uploadQuizImage.single('image'), reportUploadError, controller.uploadQuestionImage);
// اعتماد المصحّح الآلي وتجريبه: **الأدمن بس**. القرار على مستوى المنصة كلها — نموذج
// واحد بيصحّح كل الاختبارات لكل الطلاب — والتيم العلمي شغله الأسئلة ومراجعة الدرجات.
// الكارتين متخفيين من اللوحة كمان، والقفل هنا هو اللي بيعمل الحماية فعلًا
router.get('/grading-provider', requireAdminApi, controller.getGradingProviders);
router.post('/grading-provider', requireAdminApi, controller.setGradingProvider);
router.post('/grade-preview', requireAdminApi, controller.gradePreview);
router.post('/parse-document', uploadQuizDocument.single('document'), reportUploadError, controller.parseDocument);
// قبل /:id عشان "bootcamps" مش رقم
router.get('/bootcamps', controller.listBootcamps);
router.get('/', controller.listQuizzes);
router.post('/', controller.createQuiz);
router.get('/:id', controller.getQuiz);
router.put('/:id', controller.updateQuiz);
router.delete('/:id', controller.deleteQuiz);
router.put('/:id/questions', controller.saveQuestions);
router.post('/:id/regrade', controller.regradeQuiz);
router.post('/:id/approve', controller.approveQuizGrades);
router.get('/:id/attempts', controller.listAttempts);
router.get('/:id/question-stats', controller.getQuestionStats);
router.get('/:id/export', controller.exportAttempts);
router.get('/:id/coverage', controller.getQuizCoverage);
router.get('/attempts/:attemptId', controller.getAttempt);
router.put('/attempts/:attemptId/answers/:questionId', controller.gradeAnswer);
router.post('/attempts/:attemptId/regrade', controller.regradeAttempt);
router.post('/attempts/:attemptId/reopen', controller.reopenAttempt);
router.post('/attempts/:attemptId/approve', controller.approveAttemptGrades);

module.exports = router;
