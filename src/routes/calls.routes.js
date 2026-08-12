const express = require('express');
const router = express.Router();
const callsController = require('../controllers/calls.controller');
const { requireAuthApi, requireAdminApi, requireCallsAccessApi, requireCallAssignAccessApi } = require('../middleware/requireAuth');

router.use(requireAuthApi);
router.use(requireCallsAccessApi);

router.get('/outcomes', callsController.listOutcomes);
router.post('/outcomes', requireAdminApi, callsController.createOutcome);

router.get('/assignees', requireCallAssignAccessApi, callsController.listAssignees);
router.post('/assign', requireCallAssignAccessApi, callsController.assignStudents);
router.post('/unassign', requireCallAssignAccessApi, callsController.unassignStudents);
router.get('/students', requireCallAssignAccessApi, callsController.listStudentsForAssignment);
router.get('/students/ids', requireCallAssignAccessApi, callsController.listStudentIdsForAssignment);
router.get('/assignment-log', requireCallAssignAccessApi, callsController.getAssignmentLog);
router.get('/auto-assign-config', requireAdminApi, callsController.getAutoAssignConfig);
router.post('/auto-assign-config', requireAdminApi, callsController.updateAutoAssignConfig);
router.get('/auto-assign-log', requireAdminApi, callsController.getAutoAssignLog);

router.get('/my-list', callsController.listMyStudents);
router.get('/student/:id', callsController.getStudentProfile);
router.post('/student/:id/log', callsController.logCall);
router.patch('/logs/:logId', callsController.editCallLog);
router.patch('/student/:id/grade', callsController.updateStudentGrade);

module.exports = router;
