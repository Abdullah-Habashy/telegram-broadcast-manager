const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAdminApi);
router.get('/users', adminController.listUsers);
router.get('/sessions', adminController.listSessions);
router.get('/staff-stats', adminController.getStaffStats);
router.get('/staff-activity', adminController.getStaffActivityLog);
router.post('/users', adminController.createUser);
router.patch('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.post('/users/:id/impersonate', adminController.impersonateUser);
router.post('/users/:id/telegram-link-code', adminController.generateStaffTelegramLinkCode);

module.exports = router;
