const express = require('express');
const router = express.Router();
const controller = require('../controllers/quizzes.controller');
const { requireAuthApi } = require('../middleware/requireAuth');

// إدارة الاختبارات متاحة لأي موظف مسجّل دخول — نفس منطق رابط تقرير الطالب: اللي بيتابع
// الطلاب هو اللي بيبني الاختبار وبيراجع تصحيحه. الصفحة العامة نفسها متسجّلة في server.js
// على /q/:token برّه المسارات المحمية
router.use(requireAuthApi);

router.get('/', controller.listQuizzes);
router.post('/', controller.createQuiz);
router.get('/:id', controller.getQuiz);
router.put('/:id', controller.updateQuiz);
router.delete('/:id', controller.deleteQuiz);
router.put('/:id/questions', controller.saveQuestions);
router.get('/:id/attempts', controller.listAttempts);
router.get('/attempts/:attemptId', controller.getAttempt);
router.put('/attempts/:attemptId/answers/:questionId', controller.gradeAnswer);
router.post('/attempts/:attemptId/regrade', controller.regradeAttempt);

module.exports = router;
