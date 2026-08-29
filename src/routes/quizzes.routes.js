const express = require('express');
const router = express.Router();
const controller = require('../controllers/quizzes.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

// أدمن بس — تبويب الاختبارات في اللوحة جوه كتلة الأدمن زي القوالب والتقارير والذكاء الصناعي،
// والمسارات هنا لازم تقول نفس الكلام. الفرق بين الاتنين كان معناه إن موظف مايشوفش التبويب
// يقدر برضه يبني اختبار أو يغيّر درجة لو نادى المسار مباشرة.
// الصفحة العامة للطالب متسجّلة في server.js على /q/:token برّه المسارات المحمية دي
router.use(requireAdminApi);

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
