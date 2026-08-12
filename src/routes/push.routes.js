const express = require('express');
const router = express.Router();
const pushController = require('../controllers/push.controller');
const { requireAuthApi } = require('../middleware/requireAuth');

router.get('/public-key', pushController.getPublicKey);
router.use(requireAuthApi);
router.post('/subscribe', pushController.subscribe);
router.post('/unsubscribe', pushController.unsubscribe);

module.exports = router;
