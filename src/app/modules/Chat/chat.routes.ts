import express from 'express';
import auth from '../../middleware/auth';
import { USER_ROLE } from '../Auth/auth.constant';
import { ChatControllers } from './chat.controller';
import validateRequest from '../../middleware/validateRequest';
import { askQuestionValidationSchema } from './chat.validation';

const router = express.Router();

router.post(
  '/ask-question',
  auth(USER_ROLE.student),
  validateRequest(askQuestionValidationSchema),
  ChatControllers.askSyllabusQuestion
);

export const ChatRoutes = router;
