import express from 'express';
import auth from '../../middleware/auth';
import { USER_ROLE } from '../Auth/auth.constant';
import { AdminControllers } from './admin.controller';

const router = express.Router();

router.get(
  '/stats',
  auth(USER_ROLE.admin, USER_ROLE.superAdmin),
  AdminControllers.getDashboardStats
);
router.get(
  '/graphs',
  auth(USER_ROLE.admin, USER_ROLE.superAdmin),
  AdminControllers.getAdminGraphs
);
router.get(
  '/user-management/stats',
  auth(USER_ROLE.admin, USER_ROLE.superAdmin),
  AdminControllers.getUserManagementStats
);

router.delete(
  '/admin-delete-user/:id',
  auth(USER_ROLE.admin, USER_ROLE.superAdmin), 
  AdminControllers.adminDeleteUser
);

export const AdminRoutes = router;