const express = require('express');
const controller = require('../controllers/tafra.controller');
const { requireAdminApi } = require('../middleware/requireAuth');

const router = express.Router();
router.use(requireAdminApi);
router.get('/status', controller.getStatus);
router.get('/students', controller.listStudents);
router.get('/student-filters', controller.getStudentFilters);
router.post('/credentials', controller.saveCredentials);
router.post('/sync', controller.syncStudents);
router.post('/sync-enrollments', controller.syncEnrollments);
router.post('/sync-bootcamps', controller.syncBootcampNames);

module.exports = router;
