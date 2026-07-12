import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import httpStatus from 'http-status';
import { ChatServices } from './chat.service';

const askSyllabusQuestion = catchAsync(async (req: Request, res: Response) => {
  const { question, syllabusId } = req.body;

  const result = await ChatServices.getAnswerFromSyllabus(
    question,
    syllabusId,
    req.user.userId
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Answer generated successfully',
    data: result,
  });
});

export const ChatControllers = {
  askSyllabusQuestion,
};
