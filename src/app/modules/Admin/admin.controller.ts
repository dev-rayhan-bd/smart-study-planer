import { Request, Response } from "express";
import catchAsync from "../../utils/catchAsync";
import sendResponse from "../../utils/sendResponse";
import { AdminServices } from "./admin.services";
import httpStatus from 'http-status';

const getDashboardStats = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminServices.getAdminDashboardStatsFromDB();
  
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Admin Dashboard data retrieved successfully',
    data: result,
  });
});

const getAdminGraphs = catchAsync(async (req: Request, res: Response) => {
  const { range } = req.query;
  const result = await AdminServices.getAdminGraphDataFromDB(range as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Graph analytics data retrieved successfully',
    data: result,
  });
});

const getUserManagementStats = catchAsync(async (req: Request, res: Response) => {
  const result = await AdminServices.getUserManagementStatsFromDB();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User management stats retrieved',
    data: result,
  });
});

const adminDeleteUser = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params; 
  await AdminServices.adminDeleteUserFromDB(id as string);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User and all associated data deleted successfully by admin",
    data: null,
  });
});

export const AdminControllers = {
  getDashboardStats,
  getAdminGraphs,
  getUserManagementStats,
  adminDeleteUser,
};