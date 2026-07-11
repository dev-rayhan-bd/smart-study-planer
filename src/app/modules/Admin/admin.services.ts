import { Types } from 'mongoose';
import { UserModel } from '../User/user.model';
import { StudyPlanModel } from '../StudyPlan/studyPlan.model';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';

const getAdminDashboardStatsFromDB = async () => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // ── User counts ──
  const totalStudents = await UserModel.countDocuments({ role: 'student' });
  const totalAdmins = await UserModel.countDocuments({ role: { $in: ['admin', 'superAdmin'] } });

  // ── DAU / MAU ──
  const dailyActiveUsers = await UserModel.countDocuments({
    role: 'student',
    updatedAt: { $gte: todayStart },
  });
  const monthlyActiveUsers = await UserModel.countDocuments({
    role: 'student',
    updatedAt: { $gte: thirtyDaysAgo },
  });

  // ── Study Plan stats ──
  const totalStudyPlans = await StudyPlanModel.countDocuments();
  const activePlans = await StudyPlanModel.countDocuments({ status: 'active' });
  const completedPlans = await StudyPlanModel.countDocuments({ status: 'completed' });
  const plansToday = await StudyPlanModel.countDocuments({ createdAt: { $gte: todayStart } });

  // ── Completion Rate ──
  const completionRate =
    totalStudyPlans > 0
      ? parseFloat(((completedPlans / totalStudyPlans) * 100).toFixed(1))
      : 0;

  return {
    metrics: {
      totalStudents,
      totalAdmins,
      dailyActiveUsers,
      monthlyActiveUsers,
      totalStudyPlans,
      activePlans,
      completedPlans,
      plansToday,
      completionRate, // e.g. 45.8
    },
  };
};

const getAdminGraphDataFromDB = async (range: string = '7d') => {
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  startDate.setHours(0, 0, 0, 0);

  // ── User activity (DAU based on updatedAt) ──
  const userStats = await UserModel.aggregate([
    {
      $match: {
        role: 'student',
        updatedAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } },
        dau: { $sum: 1 },
      },
    },
  ]);

  // ── Study plans created per day ──
  const planStats = await StudyPlanModel.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        created: { $sum: 1 },
      },
    },
  ]);

  // ── Build chart arrays for each day in the range ──
  const userActivityChart: { date: string; dau: number }[] = [];
  const plansPerDayChart: { date: string; created: number }[] = [];

  for (let i = 0; i < days; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + i);

    const dateStr = currentDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const displayDate = currentDate.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
    });

    const uFound = userStats.find((item) => item._id === dateStr);
    userActivityChart.push({
      date: displayDate,
      dau: uFound ? uFound.dau : 0,
    });

    const pFound = planStats.find((item) => item._id === dateStr);
    plansPerDayChart.push({
      date: displayDate,
      created: pFound ? pFound.created : 0,
    });
  }

  return {
    userActivityChart,
    plansPerDayChart,
  };
};

const getUserManagementStatsFromDB = async () => {
  const totalUsers = await UserModel.countDocuments();
  const admins = await UserModel.countDocuments({ role: { $in: ['admin', 'superAdmin'] } });
  const students = await UserModel.countDocuments({ role: 'student' });

  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  const activeNow = await UserModel.countDocuments({
    updatedAt: { $gte: thirtyMinutesAgo },
  });

  const activePercentage =
    totalUsers > 0 ? ((activeNow / totalUsers) * 100).toFixed(1) : '0.0';

  return {
    totalUsers: { count: totalUsers },
    students: { count: students },
    activeNow: { count: activeNow, percentage: `${activePercentage}% of total` },
    admins: { count: admins, access: 'Full access' },
  };
};

const adminDeleteUserFromDB = async (targetId: string) => {
  const user = await UserModel.findById(targetId);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found!");
  }

  await UserModel.findByIdAndDelete(targetId);
  await StudyPlanModel.deleteMany({ user: targetId });

  return null;
};

export const AdminServices = {
  getAdminDashboardStatsFromDB,
  getAdminGraphDataFromDB,
  getUserManagementStatsFromDB,
  adminDeleteUserFromDB,
};