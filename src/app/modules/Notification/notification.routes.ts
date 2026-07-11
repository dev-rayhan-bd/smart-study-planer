import { Router } from 'express';
import auth from '../../middleware/auth';
import { USER_ROLE } from '../Auth/auth.constant';
import { NotificationController } from './notification.controller';

const router = Router();

router.get(
  '/my-notifications',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  NotificationController.getMyNotifications
);

router.patch(
  '/mark-all-read',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  NotificationController.markAsRead
);

router.patch(
  '/mark-read/:id',
  auth(USER_ROLE.student, USER_ROLE.admin, USER_ROLE.superAdmin),
  NotificationController.markSingleAsRead
);

export const NotificationRoutes = router;