import { Types } from 'mongoose';

export interface IDayPlan {
  day: number;
  topic: string;
  tasks: string[];
}

export interface IStudyPlan {
  user: Types.ObjectId;
  subject: string;
  examDate: Date;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topics: string[];
  aiPlan: IDayPlan[];
  status: 'active' | 'completed';
  createdAt?: Date;
  updatedAt?: Date;
}
