const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { requireAuthApi, requireAdminApi } = require('../middleware/requireAuth');

// متاحة لأي مستخدم مسجّل دخول (مش أدمن بس) — كل موظف يقدر يشوف متابعة أدائه هو بس، مش أداء غيره.
// requireAdminApi اللي تحت مش بيغطّيها لأنها اتسجّلت هنا قبله
router.get('/staff-activity', requireAuthApi, adminController.getStaffActivityLog);
router.get('/staff-response-stats', requireAuthApi, adminController.getStaffResponseStats);

router.use(requireAdminApi);
router.get('/users', adminController.listUsers);
router.get('/sessions', adminController.listSessions);
router.get('/staff-stats', adminController.getStaffStats);
router.post('/users', adminController.createUser);
router.patch('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.post('/users/:id/impersonate', adminController.impersonateUser);
router.post('/users/:id/telegram-link-code', adminController.generateStaffTelegramLinkCode);

module.exports = router;
