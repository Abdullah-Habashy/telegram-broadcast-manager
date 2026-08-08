const express = require('express');
const multer = require('multer');
const router = express.Router();
const contactsController = require('../controllers/contacts.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

// نخزن ملف الـCSV في الذاكرة مؤقتًا (مش على الديسك) — كافي لملفات جهات الاتصال العادية
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 ميجا حد أقصى
});

router.use(requireAdminApi);

router.get('/', contactsController.listContacts);
router.post('/import', upload.single('file'), contactsController.importContacts);
router.get('/export', contactsController.exportContacts);
router.post('/:id/tags', contactsController.assignTag);
router.delete('/:id/tags/:tagId', contactsController.removeTag);

module.exports = router;
