import { Schema, model } from 'mongoose';
import { ISyllabusChunk } from './chat.interface';

const syllabusChunkSchema = new Schema<ISyllabusChunk>(
  {
    syllabusId: {
      type: Schema.Types.ObjectId,
      ref: 'StudyPlan',
      required: true,
    },
    userId: { type: String, required: true },
    text: { type: String, required: true },
    embedding: { type: [Number], required: true },
    chunkIndex: { type: Number, required: true },
  },
  { timestamps: true }
);

// Text index for fallback keyword search
syllabusChunkSchema.index({ text: 'text' });

// Compound index for efficient filtering by syllabus
syllabusChunkSchema.index({ syllabusId: 1, userId: 1 });

export const SyllabusChunkModel = model<ISyllabusChunk>(
  'SyllabusChunk',
  syllabusChunkSchema
);
