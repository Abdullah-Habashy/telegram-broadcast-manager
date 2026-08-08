const express = require('express');
const router = express.Router();
const templatesController = require('../controllers/templates.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAdminApi);

router.get('/', templatesController.listTemplates);
router.post('/', templatesController.createTemplate);
router.delete('/:id', templatesController.deleteTemplate);

module.exports = router;
