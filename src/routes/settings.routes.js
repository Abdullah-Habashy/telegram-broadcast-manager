const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAdminApi);

router.get('/', settingsController.getSettings);
router.post('/bot-token', settingsController.saveBotToken);
router.post('/bots', settingsController.createBotProfile);
router.post('/bots/:id/activate', settingsController.activateBotProfile);
router.delete('/bots/:id', settingsController.deleteBotProfile);
router.post('/auto-reply', settingsController.updateAutoReply);
router.post('/forwarding', settingsController.updateForwarding);
router.post('/follow-up-automation', settingsController.updateFollowUpAutomation);
router.post('/agent-introduction', settingsController.updateAgentIntroduction);
router.post('/idea-settings', settingsController.updateMaxIdeaNumber);

module.exports = router;
