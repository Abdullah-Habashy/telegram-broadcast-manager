const express = require('express');
const router = express.Router();
const assistController = require('../controllers/assist.controller');
const { requireAuthApi, requireTicketsAccessApi, requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAuthApi);

// الموظف بيقرا الردود الجاهزة بس — الإضافة والتعديل للأدمن
router.get('/quick-replies', requireTicketsAccessApi, assistController.listQuickReplies);
router.post('/quick-replies', requireAdminApi, assistController.createQuickReply);
router.patch('/quick-replies/:id', requireAdminApi, assistController.updateQuickReply);
router.delete('/quick-replies/:id', requireAdminApi, assistController.deleteQuickReply);

// قاعدة المعرفة وسجل الردود الآلية — أدمن بس. دي اللي بتحدد الطلاب هيسمعوا إيه وإحنا مش
// موجودين، فمش مكان لصلاحية أوسع
router.get('/knowledge', requireAdminApi, assistController.listKnowledge);
router.post('/knowledge', requireAdminApi, assistController.createKnowledge);
router.patch('/knowledge/:id', requireAdminApi, assistController.updateKnowledge);
router.delete('/knowledge/:id', requireAdminApi, assistController.deleteKnowledge);
router.post('/knowledge/test', requireAdminApi, assistController.testKnowledge);
router.get('/ai-log', requireAdminApi, assistController.getAiLog);

module.exports = router;
