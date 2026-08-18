const express = require('express');
const router = express.Router();
const performanceController = require('../controllers/performance.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

// متابعة الأداء شاشة إدارية بالكامل: بتقارن كل الموظفين ببعض وبتعرض أرقام المنصة كلها،
// فمفيش نسخة مقلّصة للموظف — الموظف عنده تبويبات "متابعة الأداء" و"سرعة الرد" جوه صندوق
// الدعم وهي مقفولة على حسابه هو
router.use(requireAdminApi);
router.get('/summary', performanceController.getSummary);
router.get('/staff', performanceController.getStaffPerformance);
router.get('/staff/:id', performanceController.getStaffMemberReport);

module.exports = router;
