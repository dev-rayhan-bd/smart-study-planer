import { z } from 'zod';
import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { PDFParse } from 'pdf-parse';
import config from '../../config';
import { StudyPlanModel } from './studyPlan.model';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import { sendNotification } from '../../utils/sendNotification';
import { ChatServices } from '../Chat/chat.service';

// ───────────────────────── PDF Text Extraction Helper ─────────────────────────
const extractTextFromPDF = async (buffer: Buffer): Promise<string> => {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  } catch {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Failed to extract text from the uploaded PDF. Please ensure the file is valid.'
    );
  }
};

// ───────────────────────── Text Cleaning Helper ─────────────────────────
/** Collapse whitespace, trim lines, and reduce token size before sending to AI. */
const cleanExtractedText = (text: string): string => {
  return text
    .replace(/\r\n/g, '\n')       // normalize line endings
    .replace(/\t/g, ' ')          // tabs → spaces
    .replace(/[ \t]+/g, ' ')      // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n')   // max 2 consecutive newlines
    .replace(/^\s+/gm, '')        // trim leading whitespace per line
    .replace(/\s+$/gm, '')        // trim trailing whitespace per line
    .trim();
};

// Truncate text to a maximum of ~2000 words to stay within AI token limits
const truncateToWordLimit = (text: string, maxWords = 2000): string => {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '... [truncated]';
};

// ───────────────────────── Zod Contract for AI Response ─────────────────────────
const aiDayPlanSchema = z.object({
  day: z.number().int().nonnegative(),
  session: z.enum(['Morning', 'Afternoon', 'Evening']),
  topic: z.string().min(1),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        estimatedMinutes: z.number().int().positive(),
        isCompleted: z.literal(false),
      })
    )
    .min(1),
  isRevisionDay: z.boolean(),
});

const aiStudyPlanResponseSchema = z.array(aiDayPlanSchema).min(1);

// ───────────────────────── AI Provider Strategy ─────────────────────────

/** Try generating the study plan with Groq (primary — free tier). */
const callGroq = async (
  client: Groq,
  systemMessage: string,
  userMessage: string
): Promise<string> => {
  const result = await client.chat.completions.create({
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ],
    model: 'llama-3.3-70b-versatile',
    temperature: 0.1,
    max_tokens: 16384,
  });
  return result.choices[0]?.message?.content || '';
};

/** Try generating the study plan with OpenAI (backup — paid). */
const callOpenAI = async (
  client: OpenAI,
  systemMessage: string,
  userMessage: string
): Promise<string> => {
  const result = await client.chat.completions.create({
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ],
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 16384,
  });
  return result.choices[0]?.message?.content || '';
};

/** Determine whether an error from Groq is retryable (rate-limit / server error). */
const isRetryableGroqError = (error: any): boolean => {
  const msg = String(error?.message || '');
  const status = error?.status ?? error?.code ?? 0;
  return (
    status === 429 ||
    status === 503 ||
    msg.includes('429') ||
    msg.includes('rate') ||
    msg.includes('quota') ||
    msg.includes('Too Many Requests') ||
    msg.includes('Service Unavailable')
  );
};

// ───────────────────────── Extract & Validate AI Response ─────────────────────────

/** Shared pipeline: regex-extract JSON, then Zod-validate. */
const extractAndValidatePlan = (rawText: string) => {
  const jsonRegex = /\[.*\]/s;
  const jsonMatch = rawText.match(jsonRegex);
  if (!jsonMatch) {
    console.error('❌ No JSON array found in AI response. Raw text:', rawText);
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to generate study plan – AI returned an unexpected response format.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.error('❌ JSON parse failed. Raw text from AI:', rawText);
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Failed to parse AI-generated study plan. The AI returned malformed JSON.'
    );
  }

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

  return validationResult.data;
};

// ───────────────────────── Main Service ─────────────────────────

const generateAiStudyPlan = async (payload: {
  subject: string;
  startDate: string;
  examDate: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topics?: string[];
  userId: string;
  fileBuffer?: Buffer;
}) => {
  // ───── 0. Validate API keys up front ─────
  if (!config.groq_api_key) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Groq API key is not configured'
    );
  }

  // ───── 1. Calculate time available from startDate → examDate ─────
  const start = new Date(payload.startDate);
  const exam = new Date(payload.examDate);
  const diffMs = exam.getTime() - start.getTime();
  const totalDaysAvailable = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  const isEmergencyMode = totalDaysAvailable <= 1;

  // ───── 2. Extract & clean syllabus text (if PDF uploaded) ─────
  let syllabusText = '';
  if (payload.fileBuffer) {
    const extractedText = await extractTextFromPDF(payload.fileBuffer);
    const cleanedText = cleanExtractedText(extractedText);
    syllabusText = truncateToWordLimit(cleanedText);

    console.log('📄 Extracted PDF text (first 500 chars):', syllabusText.substring(0, 500));

    if (!syllabusText || syllabusText.trim().length < 20) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'The uploaded PDF appears to contain very little or no readable text. Please upload a valid syllabus PDF.'
      );
    }
  } else if (!payload.topics || payload.topics.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Either upload a PDF syllabus or provide at least one topic.'
    );
  }

  // ───── 3. Build the high-speed, density-balanced AI prompt ─────
  const systemMessage = `You are a high-speed Syllabus Analyzer. Do NOT use chain-of-thought — read the input and output raw JSON immediately. You always respond with ONLY a valid JSON array — no markdown, no explanations, no extra text.`;

  const contentSource = syllabusText
    ? `--- SYLLABUS CONTENT ---\n${syllabusText}\n--- END SYLLABUS ---`
    : `Topics to cover (ALL must be included): ${payload.topics!.join(', ')}`;

  const modeLabel = isEmergencyMode
    ? '🚨 EMERGENCY STUDY MODE — Only 1 day! Pack ALL topics. 8-10 tasks per session. No breaks.'
    : '';

  const userMessage = `I provide syllabus text from a PDF and a timeframe of ${totalDaysAvailable} days.

Context:
- Exam Date: ${payload.examDate}
- Total Days Available: ${totalDaysAvailable} day(s).
- Difficulty: ${payload.difficulty}

${contentSource}

${modeLabel}

Rules — follow exactly:
1. Zero-Skip Policy: Extract EVERY heading and sub-topic. Do NOT combine into vague summaries.
2. Proportional Allocation: A 5-line topic → 15-20 min. A 5-page topic → 90-120 min.
3. Session Packing: Divide each day into "Morning", "Afternoon", "Evening". If short on time, pack multiple topics per session. If time is long, spread them out.
4. Subject Identity: Identify the actual subject from the PDF. Ignore "Operating Systems" if the text is about "Bangladesh Studies".
5. No Hallucination: Use ONLY topics present in the provided text.
6. Last Day: The final day BEFORE the exam MUST be "Full Syllabus Rapid Revision" — set isRevisionDay=true for ALL entries on that day.

✅ Output ONLY this JSON array:
[{"day":1,"session":"Morning","topic":"Exact Topic Name","tasks":[{"title":"Sub-topic detail","estimatedMinutes":45,"isCompleted":false}],"isRevisionDay":false}]`;

  // ───── 4. Failover Strategy: Groq → OpenAI ─────
  const groqClient = new Groq({ apiKey: config.groq_api_key });

  let rawText: string;

  // Step A — Try Groq (primary)
  try {
    console.log('🤖 Attempting Groq (primary)...');
    rawText = await callGroq(groqClient, systemMessage, userMessage);
    console.log('✅ Groq succeeded.');
  } catch (groqError: any) {
    console.warn('⚠️ Groq failed:', groqError?.message || groqError);

    // Step B — Check if we should fallback to OpenAI
    if (isRetryableGroqError(groqError)) {
      console.warn('🔁 Groq rate-limited / unavailable. Switching to OpenAI (backup)...');

      if (!config.openai_api_key) {
        throw new AppError(
          httpStatus.INTERNAL_SERVER_ERROR,
          'Groq is rate-limited and OpenAI backup key is not configured. Please try again later.'
        );
      }

      // Step C — Retry with OpenAI
      try {
        const openaiClient = new OpenAI({ apiKey: config.openai_api_key });
        rawText = await callOpenAI(openaiClient, systemMessage, userMessage);
        console.log('✅ OpenAI backup succeeded.');
      } catch (openaiError: any) {
        console.error('❌ OpenAI backup also failed:', openaiError?.message || openaiError);
        throw new AppError(
          httpStatus.INTERNAL_SERVER_ERROR,
          'Both AI services are currently unavailable. Please try again later.'
        );
      }
    } else {
      // Non-retryable Groq error (bad request, auth, etc.)
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        `AI service error: ${groqError?.message || 'Unknown error'}`
      );
    }
  }

  console.log('🤖 AI raw response (first 500 chars):', rawText.substring(0, 500));

  // ───── 5. Extract & validate JSON from AI response ─────
  const validPlan = extractAndValidatePlan(rawText);

  // Extract unique topics from the AI plan for storage
  const uniqueTopics = [...new Set(validPlan.map((d) => d.topic).filter(Boolean))];

  const studyPlan = await StudyPlanModel.create({
    user: payload.userId,
    subject: payload.subject,
    examDate: new Date(payload.examDate),
    difficulty: payload.difficulty,
    topics: uniqueTopics,
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

  // ───── 6. Background: Ingest PDF into vector DB for RAG chat ─────
  if (payload.fileBuffer) {
    const planId = studyPlan._id.toString();
    // Fire-and-forget — don't block the response
    ChatServices.ingestSyllabusToVectorDB(payload.fileBuffer, planId, payload.userId)
      .then((ingestResult) => {
        console.log(
          `✅ RAG ingestion complete for plan ${planId}: ${ingestResult.chunksStored} chunks indexed.`
        );
      })
      .catch((err) => {
        console.error(
          `⚠️ RAG ingestion failed for plan ${planId} (non-blocking):`,
          err?.message || err
        );
      });
  }

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
