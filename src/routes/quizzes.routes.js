const express = require('express');
const router = express.Router();
const controller = require('../controllers/quizzes.controller');
const { requireQuizAccessApi } = require('../middleware/requireAuth');

// الأدمن + التيم العلمي + الدعم الفني. نفس الشرط بالظبط اللي بيقرر ظهور التبويب في اللوحة
// (utils/teams.js) — لو اتفرقوا هيبقى فيه حد شايف التبويب وبيتردّ عليه ٤٠٣.
// الصفحة العامة للطالب متسجّلة في server.js على /q/:ref برّه المسارات المحمية دي
router.use(requireQuizAccessApi);

router.get('/', controller.listQuizzes);
router.post('/', controller.createQuiz);
router.get('/:id', controller.getQuiz);
router.put('/:id', controller.updateQuiz);
router.delete('/:id', controller.deleteQuiz);
router.put('/:id/questions', controller.saveQuestions);
router.post('/:id/regrade', controller.regradeQuiz);
router.get('/:id/attempts', controller.listAttempts);
router.get('/attempts/:attemptId', controller.getAttempt);
router.put('/attempts/:attemptId/answers/:questionId', controller.gradeAnswer);
router.post('/attempts/:attemptId/regrade', controller.regradeAttempt);

module.exports = router;
