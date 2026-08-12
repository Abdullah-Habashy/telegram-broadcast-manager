const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

router.get('/login', authController.showLogin);
router.post('/login', authController.login);

router.get('/register', authController.showRegister);
router.post('/register', authController.register);

router.post('/logout', authController.logout);
router.post('/stop-impersonation', authController.stopImpersonation);

module.exports = router;
