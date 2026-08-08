const express = require('express');
const router = express.Router();
const statsController = require('../controllers/stats.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAdminApi);
router.get('/', statsController.getStats);

module.exports = router;
