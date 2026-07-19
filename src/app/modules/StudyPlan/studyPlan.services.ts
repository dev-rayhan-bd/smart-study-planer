import { z } from 'zod';
import OpenAI from 'openai';
// Use dynamic import for pdf-parse to avoid readFile crash in serverless
import config from '../../config';
import { StudyPlanModel } from './studyPlan.model';
import AppError from '../../errors/AppError';
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import { sendNotification } from '../../utils/sendNotification';
import { ChatServices } from '../Chat/chat.service';
import * as pdfjs from 'pdfjs-dist';
// ───────────────────────── PDF Text Extraction Helper ─────────────────────────
// const extractTextFromPDF = async (buffer: Buffer): Promise<string> => {
//   try {
//     const { PDFParse } = await import('pdf-parse');
//     const parser = new PDFParse({ data: buffer });
//     const result = await parser.getText();
//     await parser.destroy();
//     return result.text;
//   } catch {
//     throw new AppError(
//       httpStatus.BAD_REQUEST,
//       'Failed to extract text from the uploaded PDF. Please ensure the file is valid.'
//     );
//   }
// };




const extractTextFromPDF = async (buffer: Buffer): Promise<string> => {
  try {
  
    const data = new Uint8Array(buffer);
    const loadingTask = pdfjs.getDocument({ data });
    const pdf = await loadingTask.promise;
    
    let fullText = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
      fullText += pageText + '\n';
    }
    
    return fullText;
  } catch (error) {
    console.error("PDF Parsing Error:", error);
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Failed to extract text from PDF. Please ensure it is a valid text-based PDF.'
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

// Truncate text to a maximum of ~30000 words to cover large PDFs (30+ pages)
const truncateToWordLimit = (text: string, maxWords = 30000): string => {
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

/** Generate the study plan with OpenAI. */
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
  // ───── 0. Validate API key up front ─────
  if (!config.openai_api_key) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'OpenAI API key is not configured'
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

  // ───── 3. Build the AI prompt ─────

  const contentSource = syllabusText
    ? `--- SYLLABUS CONTENT ---\n${syllabusText}\n--- END SYLLABUS ---`
    : '';

  const modeLabel = isEmergencyMode
    ? '🚨 EMERGENCY STUDY MODE — Only 1 day! Pack ALL topics. 8-10 tasks per session. No breaks.'
    : '';

  const openaiClient = new OpenAI({ apiKey: config.openai_api_key });

  // ───── 4a. PASS 1: Extract ALL topics from the syllabus ─────
  let allTopics: string[] = [];

  if (syllabusText) {
    console.log('📝 Pass 1: Extracting all topics from syllabus...');
    const topicExtractSystemMsg = `You are a precise Syllabus Topic Extractor. Your ONLY job is to extract a complete list of ALL topics, headings, and sub-topics from the provided syllabus text. You must return ONLY a valid JSON array of strings. No markdown, no explanations, no extra text. CRITICAL: Extract EVERY topic from EVERY page. Do NOT skip, merge, or summarize any topic. If the syllabus has 50 topics, return 50 strings. If it has 100, return 100.`;

    const topicExtractUserMsg = `Extract EVERY topic, heading, and sub-topic from the following syllabus text. Return them as a JSON array of strings. Each string should be ONE distinct topic/heading.

RULES:
- Read the ENTIRE text from start to finish
- Every heading, sub-heading, and topic MUST be included
- Do NOT skip any topic no matter how small
- Do NOT merge different topics together
- Do NOT add topics that are not in the text

Syllabus text:
${contentSource}

✅ Output ONLY a JSON array of topic strings:
["Topic 1", "Topic 2", "Topic 3", ...]`;

    try {
      const topicRaw = await callOpenAI(openaiClient, topicExtractSystemMsg, topicExtractUserMsg);
      console.log('✅ Pass 1 done. Raw response length:', topicRaw.length, 'chars');

      // Extract JSON array from response
      const topicJsonMatch = topicRaw.match(/\[.*\]/s);
      if (topicJsonMatch) {
        const parsed = JSON.parse(topicJsonMatch[0]);
        if (Array.isArray(parsed)) {
          allTopics = parsed.filter((t: any) => typeof t === 'string' && t.trim().length > 0);
          allTopics = [...new Set(allTopics)]; // deduplicate
          console.log(`📋 Extracted ${allTopics.length} unique topics from syllabus`);
        }
      }
    } catch (err: any) {
      console.error('⚠️ Pass 1 failed:', err?.message || err);
      // Fallback: try to extract topics from raw text heuristically
      const lines = syllabusText.split('\n').filter((l) => l.trim().length > 3);
      allTopics = [...new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0))];
      console.log(`📋 Fallback: extracted ${allTopics.length} topics from text lines`);
    }
  }

  // If topics were provided in the request body (no PDF), use those
  if (allTopics.length === 0 && payload.topics) {
    allTopics = payload.topics;
  }

  console.log(`📋 Total topics to plan: ${allTopics.length}`);

  // ───── 4b. PASS 2: Create study plan covering ALL topics ─────
  const systemMessage = `You are an expert Study Planner. You create a DETAILED study plan covering EVERY topic provided to you. You respond with ONLY a valid JSON array — no markdown, no explanations, no extra text.`;

  const topicsForPlan = allTopics.length > 0
    ? allTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')
    : `Topics to cover: ${payload.topics?.join(', ') || 'General study'}`;

  const userMessage = `Create a complete study plan for ${totalDaysAvailable} day(s) until the exam.

Context:
- Subject: ${payload.subject}
- Exam Date: ${payload.examDate}
- Total Days Available: ${totalDaysAvailable} day(s)
- Difficulty: ${payload.difficulty}
${modeLabel}

CRITICAL: The following ${allTopics.length} topics MUST ALL appear in the study plan. Every single one. No exceptions.

Topics to cover:
${topicsForPlan}

RULES:
- EVERY topic listed above MUST appear in the plan. Count them. If there are ${allTopics.length} topics, the plan MUST cover all ${allTopics.length}.
- Each topic gets its OWN day/session entry. Do NOT merge topics.
- Proportional time: simple topic → 20-30 min, complex topic → 60-120 min.
- Divide days into "Morning", "Afternoon", "Evening" sessions.
- Last Day BEFORE the exam: "Full Syllabus Rapid Revision" — isRevisionDay=true for ALL entries on that day.

✅ Output ONLY this JSON array:
[{"day":1,"session":"Morning","topic":"Exact Topic Name","tasks":[{"title":"Task detail","estimatedMinutes":45,"isCompleted":false}],"isRevisionDay":false}]`;

  // ───── 5. Call OpenAI ─────
  let rawText: string;

  try {
    console.log('🤖 Pass 2: Calling OpenAI for study plan...');
    rawText = await callOpenAI(openaiClient, systemMessage, userMessage);
    console.log('✅ OpenAI succeeded. Response length:', rawText.length, 'chars');
  } catch (error: any) {
    console.error('❌ OpenAI failed:', error?.message || error);
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `AI service error: ${error?.message || 'Unknown error'}`
    );
  }

  console.log('🤖 AI raw response (first 500 chars):', rawText.substring(0, 500));

  // ───── 6. Extract & validate JSON from AI response ─────
  const validPlan = extractAndValidatePlan(rawText);

  // Extract unique topics from the AI plan for storage
  const uniqueTopics = [...new Set(validPlan.map((d) => d.topic).filter(Boolean))];

  // Log coverage: how many extracted topics are in the plan
  if (allTopics.length > 0) {
    const coveredCount = allTopics.filter((t) =>
      uniqueTopics.some((ut) => ut.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(ut.toLowerCase()))
    ).length;
    console.log(`📊 Topic coverage: ${coveredCount}/${allTopics.length} topics covered in plan`);
    if (coveredCount < allTopics.length) {
      const missing = allTopics.filter((t) =>
        !uniqueTopics.some((ut) => ut.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(ut.toLowerCase()))
      );
      console.warn('⚠️ Missing topics:', missing.slice(0, 10));
    }
  }

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

/**
 * Return only _id + subject for every plan owned by the student.
 * Ideal for dropdown / select inputs on the front-end.
 */
const getPlanSubjectsForDropdown = async (userId: string) => {
  const plans = await StudyPlanModel.find({ user: userId })
    .select('subject status')
    .sort({ createdAt: -1 })
    .lean();

  return plans.map((p) => ({
    id: p._id,
    subject: p.subject,
    status: p.status,
  }));
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

const deleteStudyPlanFromDB = async (planId: string, userId: string) => {
  const plan = await StudyPlanModel.findOneAndDelete({ _id: planId, user: userId });
  if (!plan) {
    throw new AppError(httpStatus.NOT_FOUND, 'Study plan not found');
  }
  return plan;
};

const toggleTaskStatusInDB = async (
  userId: string,
  planId: string,
  taskId: string
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

  // Find the task across all days using MongoDB _id
  let found = false;
  for (const day of plan.aiPlan) {
    const task = day.tasks.find((t) => t._id?.toString() === taskId);
    if (task) {
      task.isCompleted = !task.isCompleted;
      found = true;
      break;
    }
  }

  if (!found) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Task not found in this plan');
  }

  // Calculate progress
  let totalTasks = 0;
  let completedTasks = 0;
  for (const d of plan.aiPlan) {
    totalTasks += d.tasks.length;
    completedTasks += d.tasks.filter((t) => t.isCompleted).length;
  }
  const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Check if ALL tasks across ALL days are completed
  const allCompleted = plan.aiPlan.every((d) =>
    d.tasks.every((t) => t.isCompleted)
  );

  const wasAlreadyCompleted = plan.status === 'completed';

  if (allCompleted) {
    plan.status = 'completed';
  } else {
    plan.status = 'active';
  }

  await plan.save();

  if (allCompleted && !wasAlreadyCompleted) {
    await sendNotification(
      userId,
      '🎉 Study Plan Completed!',
      `Congratulations! You have finished your study plan for ${plan.subject}!`,
      'general'
    );
  }

  return {
    plan,
    progress: {
      completedTasks,
      totalTasks,
      percentage: progressPercentage,
    },
  };
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
  getPlanSubjectsForDropdown,
  getSinglePlanFromDB,
  deleteStudyPlanFromDB,
  toggleTaskStatusInDB,
  getStudentDashboardSummaryFromDB,
};
