import { Schema, model } from 'mongoose';
import { IStudyPlan } from './studyPlan.interface';

const taskSchema = new Schema(
  {
    task: { type: String, required: true },
    completed: { type: Boolean, default: false },
  },
  { _id: false }
);

const dayPlanSchema = new Schema(
  {
    day: { type: Number, required: true },
    topic: { type: String, required: true },
    tasks: [taskSchema],
  },
  { _id: false }
);

const studyPlanSchema = new Schema<IStudyPlan>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    subject: { type: String, required: true },
    examDate: { type: Date, required: true },
    difficulty: {
      type: String,
      enum: ['Easy', 'Medium', 'Hard'],
      required: true,
    },
    topics: [{ type: String, required: true }],
    aiPlan: [dayPlanSchema],
    status: {
      type: String,
      enum: ['active', 'completed'],
      default: 'active',
    },
  },
  { timestamps: true }
);

export const StudyPlanModel = model<IStudyPlan>('StudyPlan', studyPlanSchema);
