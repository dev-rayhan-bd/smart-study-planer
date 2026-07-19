import { Types } from 'mongoose';

export interface ITask {
  _id?: Types.ObjectId;
  title: string;
  estimatedMinutes: number;
  isCompleted: boolean;
}

export interface IDayPlan {
  day: number;
  session: 'Morning' | 'Afternoon' | 'Evening';
  topic: string;
  tasks: ITask[];
  isRevisionDay: boolean;
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
