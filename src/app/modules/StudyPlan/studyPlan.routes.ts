import express from 'express';
import auth from '../../middleware/auth';
import { USER_ROLE } from '../Auth/auth.constant';
import { StudyPlanControllers } from './studyPlan.controller';
import validateRequest from '../../middleware/validateRequest';
import { StudyPlanValidation } from './studyPlan.validation';

const router = express.Router();

router.post(
  '/create-plan',
  auth(USER_ROLE.student),
  validateRequest(StudyPlanValidation.createStudyPlanValidationSchema),
  StudyPlanControllers.createStudyPlan
);

router.get(
  '/my-plans',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  StudyPlanControllers.getMyPlans
);

router.get(
  '/my-plans/:id',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  StudyPlanControllers.getSinglePlan
);

router.patch(
  '/toggle-task/:id',
  auth(USER_ROLE.student),
  validateRequest(StudyPlanValidation.toggleTaskValidationSchema),
  StudyPlanControllers.toggleTaskStatus
);

export const StudyPlanRoutes = router;
