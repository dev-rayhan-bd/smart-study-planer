import { z } from 'zod';

const createStudyPlanValidationSchema = z.object({
  subject: z
    .string({ required_error: 'Subject is required' })
    .trim()
    .min(1, 'Subject cannot be empty'),
  examDate: z
    .string({ required_error: 'Exam date is required' })
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid date format',
    }),
  difficulty: z.enum(['Easy', 'Medium', 'Hard'], {
    required_error: 'Difficulty is required',
  }),
  topics: z
    .array(
      z.string().trim().min(1, 'Topic cannot be empty'),
      { required_error: 'At least one topic is required' }
    )
    .min(1, 'At least one topic is required'),
});

const toggleTaskValidationSchema = z.object({
  day: z
    .number({ required_error: 'Day is required' })
    .int('Day must be an integer')
    .nonnegative('Day cannot be negative'),
  taskIndex: z
    .number({ required_error: 'Task index is required' })
    .int('Task index must be an integer')
    .nonnegative('Task index cannot be negative'),
});

export const StudyPlanValidation = {
  createStudyPlanValidationSchema,
  toggleTaskValidationSchema,
};
