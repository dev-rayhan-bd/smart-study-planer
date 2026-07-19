import express from 'express';
import auth from '../../middleware/auth';
import { USER_ROLE } from '../Auth/auth.constant';
import { StudyPlanControllers } from './studyPlan.controller';
import validateRequest from '../../middleware/validateRequest';
import { StudyPlanValidation } from './studyPlan.validation';
import { upload } from '../../middleware/multer';

const router = express.Router();

router.post(
  '/create-plan',
  auth(USER_ROLE.student),
  upload.single('syllabus'), // Accept optional PDF file upload
  (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    // When sent as form-data with a "body" text field, parse the JSON string
    if (req.body?.body) {
      try {
        req.body = JSON.parse(req.body.body);
      } catch {
        // If not JSON, keep req.body as-is for validation to handle
      }
    }
    next();
  },
  validateRequest(StudyPlanValidation.createStudyPlanValidationSchema),
  StudyPlanControllers.createStudyPlan
);

router.get(
  '/my-plans',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  StudyPlanControllers.getMyPlans
);

router.get(
  '/dropdown/subjects',
  auth(USER_ROLE.student),
  StudyPlanControllers.getPlanSubjectsForDropdown
);

router.get(
  '/dashboard/summary',
  auth(USER_ROLE.student),
  StudyPlanControllers.getDashboardSummary
);

router.get(
  '/my-plans/:id',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  StudyPlanControllers.getSinglePlan
);

router.patch(
  '/toggle-task/:id',
  auth(USER_ROLE.student),

  // validateRequest(StudyPlanValidation.toggleTaskValidationSchema),
  StudyPlanControllers.toggleTaskStatus
);

router.delete(
  '/my-plans/:id',
  auth(USER_ROLE.student),
  StudyPlanControllers.deleteStudyPlan
);

export const StudyPlanRoutes = router;
