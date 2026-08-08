const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAdminApi);
router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.patch('/users/:id', adminController.updateUser);

module.exports = router;
