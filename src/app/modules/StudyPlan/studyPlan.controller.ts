import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import httpStatus from 'http-status';
import { StudyPlanServices } from './studyPlan.services';

const createStudyPlan = catchAsync(async (req: Request, res: Response) => {
  const result = await StudyPlanServices.generateAiStudyPlan({
    ...req.body,
    userId: req.user.userId,
    fileBuffer: req.file?.buffer, // PDF syllabus buffer (if uploaded)
  });

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: 'Study plan generated successfully',
    data: result,
  });
});

const getMyPlans = catchAsync(async (req: Request, res: Response) => {
  const result = await StudyPlanServices.getMyPlansFromDB(
    req.user.userId,
    req.query
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Study plans retrieved successfully',
    data: result,
  });
});

const getSinglePlan = catchAsync(async (req: Request, res: Response) => {
  const result = await StudyPlanServices.getSinglePlanFromDB(
    req.params.id as string,
    req.user.userId
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Study plan retrieved successfully',
    data: result,
  });
});

const toggleTaskStatus = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { day, taskIndex } = req.body;

  const result = await StudyPlanServices.toggleTaskStatusInDB(
    req.user.userId,
    id as string,
    day,
    taskIndex
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Task status updated successfully',
    data: result,
  });
});

const getDashboardSummary = catchAsync(async (req: Request, res: Response) => {
  const result = await StudyPlanServices.getStudentDashboardSummaryFromDB(
    req.user.userId
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Dashboard summary retrieved successfully',
    data: result,
  });
});

export const StudyPlanControllers = {
  createStudyPlan,
  getMyPlans,
  getSinglePlan,
  toggleTaskStatus,
  getDashboardSummary,
};
