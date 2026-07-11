import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config';
import { StudyPlanModel } from './studyPlan.model';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import { sendNotification } from '../../utils/sendNotification';

const generateAiStudyPlan = async (payload: {
  subject: string;
  examDate: string;
  difficulty: string;
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

  const prompt = `Act as a professional academic mentor. Create a day-by-day study plan for "${
    payload.subject
  }" with exam date "${payload.examDate}" and difficulty level "${
    payload.difficulty}". Focus on these topics: ${payload.topics.join(
    ', '
  )}. Output strictly in JSON format as an array of objects with keys: day (number), topic (string), tasks (array of strings). Return ONLY the JSON array, no other text.`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.text();

  // Parse the JSON from the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to generate study plan - invalid AI response'
    );
  }

  let aiPlan;
  try {
    aiPlan = JSON.parse(jsonMatch[0]);
  } catch {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to parse AI-generated study plan'
    );
  }

  if (!Array.isArray(aiPlan) || aiPlan.length === 0) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'AI generated an empty study plan'
    );
  }

  // Transform AI response: convert plain task strings to { title, isCompleted }
  const transformedPlan = aiPlan.map(
    (day: { day: number; topic: string; tasks: string[] }) => ({
      day: day.day,
      topic: day.topic,
      tasks: day.tasks.map((task: string) => ({
        title: task,
        isCompleted: false,
      })),
    })
  );

  const studyPlan = await StudyPlanModel.create({
    user: payload.userId,
    subject: payload.subject,
    examDate: new Date(payload.examDate),
    difficulty: payload.difficulty,
    topics: payload.topics,
    aiPlan: transformedPlan,
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

export const StudyPlanServices = {
  generateAiStudyPlan,
  getMyPlansFromDB,
  getSinglePlanFromDB,
  toggleTaskStatusInDB,
};
