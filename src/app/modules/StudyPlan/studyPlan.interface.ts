import { Types } from 'mongoose';

export interface ITask {
  title: string;
  isCompleted: boolean;
}

export interface IDayPlan {
  day: number;
  topic: string;
  tasks: ITask[];
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
