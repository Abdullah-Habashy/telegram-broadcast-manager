const express = require('express');
const router = express.Router();
const contactsController = require('../controllers/contacts.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

router.use(requireAdminApi);

router.get('/', contactsController.listTags);
router.post('/', contactsController.createTag);

module.exports = router;
