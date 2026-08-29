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
router.post('/working-hours', settingsController.updateWorkingHours);
router.post('/forwarding', settingsController.updateForwarding);
router.post('/follow-up-automation', settingsController.updateFollowUpAutomation);
router.post('/welcome-message', settingsController.updateWelcomeMessage);
router.post('/sms-template', settingsController.updateSmsTemplate);
router.post('/agent-introduction', settingsController.updateAgentIntroduction);
router.post('/idea-settings', settingsController.updateMaxIdeaNumber);
router.post('/tafra-auto-sync', settingsController.updateTafraAutoSyncInterval);
router.post('/api-follow-up', settingsController.updateApiFollowUpBootcamps);

module.exports = router;
