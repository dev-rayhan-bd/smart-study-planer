import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config';
import { StudyPlanModel } from './studyPlan.model';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import { sendNotification } from '../../utils/sendNotification';

// ───────────────────────── Zod Contract for AI Response ─────────────────────────
const aiDayPlanSchema = z.object({
  day: z.number().int().nonnegative(),
  topic: z.string().min(1),
  tasks: z.array(
    z.object({
      title: z.string().min(1),
      isCompleted: z.literal(false),
    })
  ).min(1),
});

const aiStudyPlanResponseSchema = z.array(aiDayPlanSchema).min(1);

const generateAiStudyPlan = async (payload: {
  subject: string;
  examDate: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topics: string[];
  userId: string;
}) => {
  if (!config.google_api_key) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Google API key is not configured'
    );
  }

  const genAI = new GoogleGenerativeAI(config.google_api_key);
  const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

  // 1. Enhanced prompt — strict system instruction
  const prompt = `You are a strict JSON generator. Your output must contain ONLY a valid JSON array of objects. Do not include introductory text, explanations, or markdown formatting like \`\`\`json ... \`\`\`. If you fail to provide strictly valid JSON, the system will crash.

Create a day-by-day study plan for "${payload.subject}" with exam date "${payload.examDate}" and difficulty level "${payload.difficulty}". Focus on these topics: ${payload.topics.join(', ')}.

Each object in the array must have:
- "day" (number)
- "topic" (string)
- "tasks" (array of objects with "title" string and "isCompleted" boolean set to false)

Return ONLY the JSON array, no other text.`;

  let text: string;

  // 2. Robust AI call with try-catch
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (error) {
    console.error('❌ Gemini API call failed:', error);
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'AI service is currently unavailable. Please try again later.'
    );
  }

  // 3. Regex-based extraction — find the JSON array anywhere in the response
  const jsonRegex = /\[.*\]/s;
  const jsonMatch = text.match(jsonRegex);
  if (!jsonMatch) {
    console.error('❌ No JSON array found in AI response. Raw text:', text);
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to generate study plan – AI returned an unexpected response format.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.error('❌ JSON parse failed. Raw text from Gemini:', text);
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to parse AI-generated study plan. The AI returned malformed JSON.'
    );
  }

  // 4. Zod validation — guarantee the structure before saving to DB
  const validationResult = aiStudyPlanResponseSchema.safeParse(parsed);
  if (!validationResult.success) {
    console.error(
      '❌ Zod validation of AI response failed:',
      validationResult.error.flatten()
    );
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'AI generated an invalid study plan structure. Please try again.'
    );
  }

  const validPlan = validationResult.data;

  const studyPlan = await StudyPlanModel.create({
    user: payload.userId,
    subject: payload.subject,
    examDate: new Date(payload.examDate),
    difficulty: payload.difficulty,
    topics: payload.topics,
    aiPlan: validPlan,
    status: 'active',
  });

  // Send in-app notification
  await sendNotification(
    payload.userId,
    'Study Plan Generated 📚',
    `Your AI study plan for ${payload.subject} is ready! Check it out in My Plans.`,
    'general'
  );

  return studyPlan;
};

const getMyPlansFromDB = async (
  userId: string,
  query: Record<string, unknown>
) => {
  const baseQuery = StudyPlanModel.find({ user: userId });
  const planQuery = new QueryBuilder(baseQuery, query)
    .search(['subject'])
    .filter()
    .sort()
    .paginate()
    .fields();

  const result = await planQuery.modelQuery;
  const meta = await planQuery.countTotal();
  return { meta, result };
};

const getSinglePlanFromDB = async (planId: string, userId: string) => {
  const plan = await StudyPlanModel.findOne({ _id: planId, user: userId });
  if (!plan) {
    throw new AppError(httpStatus.NOT_FOUND, 'Study plan not found');
  }
  return plan;
};

const toggleTaskStatusInDB = async (
  userId: string,
  planId: string,
  dayNumber: number,
  taskIndex: number
) => {
  // Security check: ensure the plan belongs to the userId
  const plan = await StudyPlanModel.findOne({ _id: planId });
  if (!plan) {
    throw new AppError(httpStatus.NOT_FOUND, 'Study plan not found');
  }

  if (plan.user.toString() !== userId) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      'You are not authorized to modify this study plan'
    );
  }

  // Validate dayNumber bounds
  if (dayNumber < 0 || dayNumber >= plan.aiPlan.length) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid day number');
  }

  // Validate taskIndex bounds
  const day = plan.aiPlan[dayNumber];
  if (taskIndex < 0 || taskIndex >= day.tasks.length) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid task index');
  }

  // Toggle the task's isCompleted value
  day.tasks[taskIndex].isCompleted = !day.tasks[taskIndex].isCompleted;

  // Check if ALL tasks across ALL days are completed
  const allCompleted = plan.aiPlan.every((d) =>
    d.tasks.every((t) => t.isCompleted)
  );

  // Determine previous status for notification logic
  const wasAlreadyCompleted = plan.status === 'completed';

  // Auto-update plan status
  if (allCompleted) {
    plan.status = 'completed';
  } else {
    plan.status = 'active';
  }

  await plan.save();

  // Notification: if plan just became completed, send congratulations
  if (allCompleted && !wasAlreadyCompleted) {
    await sendNotification(
      userId,
      '🎉 Study Plan Completed!',
      `Congratulations! You have finished your study plan for ${plan.subject}!`,
      'general'
    );
  }

  return plan;
};

/**
 * Get a dashboard summary for a student user.
 * Aggregates: today's tasks, overall progress %, next exam countdown, and total stats.
 */
const getStudentDashboardSummaryFromDB = async (userId: string) => {
  // 1. Fetch all active plans for the user
  const activePlans = await StudyPlanModel.find({
    user: userId,
    status: 'active',
  });

  const today = new Date();
  const startOfToday = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  );

  // 2. Prepare today's tasks array
  const todaysTasks: {
    planId: string;
    subject: string;
    day: number;
    topic: string;
    tasks: { title: string; isCompleted: boolean }[];
  }[] = [];

  // 3. Aggregators for completion percentage
  let totalTasks = 0;
  let completedTasks = 0;

  for (const plan of activePlans) {
    // Calculate which "day" of the plan we're on
    const createdAt = new Date(plan.createdAt!);
    const startOfCreatedAt = new Date(
      Date.UTC(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate())
    );
    const dayDiff = Math.floor(
      (startOfToday.getTime() - startOfCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const currentDay = Math.max(0, dayDiff); // Day 0 = first day

    // Find the matching day in aiPlan (day field is 1-based in AI output)
    const matchingDay = plan.aiPlan.find((d) => d.day === currentDay + 1);
    if (matchingDay) {
      todaysTasks.push({
        planId: plan._id.toString(),
        subject: plan.subject,
        day: matchingDay.day,
        topic: matchingDay.topic,
        tasks: matchingDay.tasks.map((t) => ({
          title: t.title,
          isCompleted: t.isCompleted,
        })),
      });
    }

    // Accumulate totals for completion percentage
    for (const day of plan.aiPlan) {
      totalTasks += day.tasks.length;
      completedTasks += day.tasks.filter((t) => t.isCompleted).length;
    }
  }

  // 4. Calculate overall progress percentage
  const overallProgress =
    totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // 5. Find the next closest exam (across ALL plans — active or completed)
  const nextExamPlan = await StudyPlanModel.findOne({
    user: userId,
    examDate: { $gte: today },
  })
    .sort({ examDate: 1 })
    .select('subject examDate');

  let nextExam: { subject: string; daysLeft: number } | null = null;
  if (nextExamPlan) {
    const examDate = new Date(nextExamPlan.examDate);
    const startOfExam = new Date(
      Date.UTC(examDate.getFullYear(), examDate.getMonth(), examDate.getDate())
    );
    const daysLeft = Math.max(
      0,
      Math.round(
        (startOfExam.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24)
      )
    );
    nextExam = {
      subject: nextExamPlan.subject,
      daysLeft,
    };
  }

  // 6. Overall stats
  const totalPlansCount = await StudyPlanModel.countDocuments({ user: userId });
  const completedPlansCount = await StudyPlanModel.countDocuments({
    user: userId,
    status: 'completed',
  });

  const totalStats = {
    activePlans: activePlans.length,
    completedPlans: completedPlansCount,
    totalPlans: totalPlansCount,
    totalTasksCompleted: completedTasks,
  };

  return {
    todaysTasks,
    overallProgress,
    nextExam,
    totalStats,
  };
};

export const StudyPlanServices = {
  generateAiStudyPlan,
  getMyPlansFromDB,
  getSinglePlanFromDB,
  toggleTaskStatusInDB,
  getStudentDashboardSummaryFromDB,
};
