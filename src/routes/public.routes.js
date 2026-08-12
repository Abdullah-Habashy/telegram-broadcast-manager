const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');

// بدون أي تسجيل دخول أو مفتاح API — بناءً على طلب صريح، النقطة دي مفتوحة لأي نظام خارجي
router.get('/student-status', publicController.getStudentStartStatus);

module.exports = router;
