import { Types } from 'mongoose';

export interface ISyllabusChunk {
  syllabusId: Types.ObjectId;
  userId: string;
  text: string;
  embedding: number[];
  chunkIndex: number;
  createdAt?: Date;
  updatedAt?: Date;
}
