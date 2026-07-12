import { Router } from 'express';
import { AuthRoutes } from '../modules/Auth/auth.routes';
import { UserRoutes } from '../modules/User/user.routes';
import aboutRouter from '../modules/about/about.route';
import privacyPolicyRouter from '../modules/PrivacyPolicy/privacyPolicy.routes';
import termsRouter from '../modules/Terms/terms.route';
import { FaqRoutes } from '../modules/FAQ/faq.routes';
import { ContactRoutes } from '../modules/ContactUs/contact.route';
import { AdminRoutes } from '../modules/Admin/admin.routes';
import { NotificationRoutes } from '../modules/Notification/notification.routes';
import { StudyPlanRoutes } from '../modules/StudyPlan/studyPlan.routes';
import { ChatRoutes } from '../modules/Chat/chat.routes';

const router = Router();

const moduleRoutes = [
  {
    path: '/auth',
    route: AuthRoutes,
  },
  {
    path: '/user',
    route: UserRoutes,
  },
  {
    path: '/about',
    route: aboutRouter,
  },
  {
    path: '/privacy',
    route: privacyPolicyRouter,
  },
  {
    path: '/terms',
    route: termsRouter,
  },
  {
    path: '/faq',
    route: FaqRoutes,
  },
  {
    path: '/contact',
    route: ContactRoutes,
  },
  {
    path: '/admin',
    route: AdminRoutes,
  },
  {
    path: '/notifications',
    route: NotificationRoutes,
  },
  {
    path: '/study-plans',
    route: StudyPlanRoutes,
  },
  {
    path: '/chat',
    route: ChatRoutes,
  },
];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
