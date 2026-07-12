import { z } from 'zod';

export const askQuestionValidationSchema = z.object({
  question: z
    .string({ message: 'Question is required' })
    .min(3, { message: 'Question must be at least 3 characters long' })
    .max(1000, { message: 'Question must not exceed 1000 characters' }),
  syllabusId: z
    .string({ message: 'Syllabus ID is required' })
    .regex(/^[0-9a-fA-F]{24}$/, { message: 'Invalid syllabus ID format' }),
});
