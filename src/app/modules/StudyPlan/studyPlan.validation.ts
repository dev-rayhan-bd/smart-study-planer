import { z } from 'zod';

const createStudyPlanValidationSchema = z.object({
  subject: z
    .string({ message: 'Subject is required' })
    .trim()
    .min(1, 'Subject cannot be empty'),
  startDate: z
    .string({ message: 'Start date is required' })
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid start date format',
    }),
  examDate: z
    .string({ message: 'Exam date is required' })
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid exam date format',
    }),
  difficulty: z.enum(['Easy', 'Medium', 'Hard'], {
    message: 'Difficulty is required',
  }),
  topics: z
    .array(
      z.string().trim().min(1, 'Topic cannot be empty'),
      { message: 'At least one topic is required' }
    )
    .min(1, 'At least one topic is required')
    .optional(), // Optional when PDF syllabus is uploaded
});

const toggleTaskValidationSchema = z.object({
  day: z
    .number({ message: 'Day is required' })
    .int('Day must be an integer')
    .nonnegative('Day cannot be negative'),
  taskIndex: z
    .number({ message: 'Task index is required' })
    .int('Task index must be an integer')
    .nonnegative('Task index cannot be negative'),
});

export const StudyPlanValidation = {
  createStudyPlanValidationSchema,
  toggleTaskValidationSchema,
};
