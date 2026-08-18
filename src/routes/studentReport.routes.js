const express = require('express');
const router = express.Router();
const controller = require('../controllers/studentReport.controller');
const { requireAuthApi } = require('../middleware/requireAuth');

// إدارة رابط التقرير — متاحة لأي موظف مسجّل دخول، مش للأدمن بس: الزرار موجود في صندوق الدعم
// والمتابعة التليفونية واللي بيشتغل عليهم موظفين، وهما أصلًا شايفين نفس البيانات جوه اللوحة.
// الصفحة العامة نفسها متسجّلة في server.js على /r/:token برّه المسارات المحمية
router.use(requireAuthApi);
router.get('/ticket/:id/student', controller.resolveStudentIdFromTicket);
router.get('/:id', controller.getReportLink);
router.post('/:id', controller.createReportLink);
router.delete('/:id', controller.revokeReportLink);

module.exports = router;
