const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const broadcastController = require('../controllers/broadcast.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      const extension = file.mimetype === 'image/png' ? '.png' : '.jpg';
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      return callback(new Error('مسموح بصور JPG وPNG فقط'));
    }
    callback(null, true);
  },
});

router.use(requireAdminApi);

router.get('/', broadcastController.listBroadcasts);
router.post('/', upload.single('image'), broadcastController.createBroadcast);
router.get('/:id', broadcastController.getBroadcast);

module.exports = router;
