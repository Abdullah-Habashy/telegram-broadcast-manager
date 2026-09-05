const express = require('express');
const router = express.Router();
const assistController = require('../controllers/assist.controller');
const { requireAuthApi, requireTicketsAccessApi, requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAuthApi);

// الموظف بيقرا الردود الجاهزة بس — الإضافة والتعديل للأدمن
router.get('/quick-replies', requireTicketsAccessApi, assistController.listQuickReplies);
// الموظف بيضيف ويعدّل ويحذف **ردوده الشخصية بس** — الملكية بتتحقق في المتحكّم نفسه.
// الأدمن بيعمل ردود عامة للفريق وبيقدر يلمس أي رد
router.post('/quick-replies', requireTicketsAccessApi, assistController.createQuickReply);
router.patch('/quick-replies/:id', requireTicketsAccessApi, assistController.updateQuickReply);
router.delete('/quick-replies/:id', requireTicketsAccessApi, assistController.deleteQuickReply);

// قاعدة المعرفة وسجل الردود الآلية — أدمن بس. دي اللي بتحدد الطلاب هيسمعوا إيه وإحنا مش
// موجودين، فمش مكان لصلاحية أوسع
router.get('/knowledge', requireAdminApi, assistController.listKnowledge);
router.post('/knowledge', requireAdminApi, assistController.createKnowledge);
router.patch('/knowledge/:id', requireAdminApi, assistController.updateKnowledge);
router.delete('/knowledge/:id', requireAdminApi, assistController.deleteKnowledge);
router.post('/knowledge/test', requireAdminApi, assistController.testKnowledge);
router.get('/ai-log', requireAdminApi, assistController.getAiLog);
router.put('/ai-settings', requireAdminApi, assistController.updateAiSettings);

// المساحة التجريبية — أدمن بس: دي اللي بتحدد إيه اللي هيدخل مصادر البوت
router.post('/chat', requireAdminApi, assistController.chat);
router.post('/harvest/chat', requireAdminApi, assistController.harvestChat);
router.post('/harvest/file', requireAdminApi, assistController.harvestFile);
router.post('/knowledge/apply', requireAdminApi, assistController.applyChanges);
router.get('/mine/preview', requireAdminApi, assistController.previewClusters);
router.post('/mine', requireAdminApi, assistController.mineHistory);

// قايمة التعليمات ومساحة التدريب — أدمن بس، زي قاعدة المعرفة بالظبط: التعليمة بتدخل الـ prompt
// والتدريب بيكتب في المصدر
router.get('/instructions', requireAdminApi, assistController.listInstructions);
router.post('/instructions', requireAdminApi, assistController.createInstruction);
router.patch('/instructions/:id', requireAdminApi, assistController.updateInstruction);
router.delete('/instructions/:id', requireAdminApi, assistController.deleteInstruction);

router.get('/training/tickets', requireAdminApi, assistController.searchTrainingTickets);
router.get('/training/runs', requireAdminApi, assistController.listTrainingRuns);
router.get('/training/runs/:id', requireAdminApi, assistController.getTrainingRun);
router.post('/training/run', requireAdminApi, assistController.startTraining);
router.patch('/training/items/:id', requireAdminApi, assistController.reviewTrainingItem);
router.post('/training/items/:id/knowledge', requireAdminApi, assistController.promoteTrainingItem);

module.exports = router;
