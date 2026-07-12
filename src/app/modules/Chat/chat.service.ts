import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { OpenAIEmbeddings } from '@langchain/openai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';
import httpStatus from 'http-status';
import config from '../../config';
import AppError from '../../errors/AppError';
import { SyllabusChunkModel } from './chat.model';
import { StudyPlanModel } from '../StudyPlan/studyPlan.model';

// ───────────────────────── Constants ─────────────────────────

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const VECTOR_SEARCH_TOP_K = 5;
const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dimensions
const EMBEDDING_BATCH_SIZE = 20; // OpenAI supports batch embedding

// ───────────────────────── Ingestion Pipeline ─────────────────────────

/**
 * Ingest a syllabus PDF buffer into the vector DB.
 * Called automatically after study plan creation.
 */
const ingestSyllabusToVectorDB = async (
  pdfBuffer: Buffer,
  syllabusId: string,
  userId: string
): Promise<{ chunksStored: number }> => {
  // ── Step 0: Validate OpenAI key for embeddings ──
  if (!config.openai_api_key) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'OpenAI API key is required for document embeddings but is not configured.'
    );
  }

  // ── Step 1: Extract text from PDF ──
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();
  await parser.destroy();

  const rawText = result.text;
  if (!rawText || rawText.trim().length < 50) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'The uploaded PDF contains too little text to index.'
    );
  }

  console.log(`📄 Extracted ${rawText.length} characters from PDF for indexing.`);

  // ── Step 2: Chunk the text with LangChain ──
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ['\n\n', '\n', '. ', ' ', ''],
    lengthFunction: (text) => text.length,
  });

  const langchainDocs = await splitter.createDocuments([rawText]);
  const chunks = langchainDocs.map((doc) => doc.pageContent);

  console.log(`✂️ Split into ${chunks.length} chunks.`);

  if (chunks.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Could not generate any chunks from the PDF content.'
    );
  }

  // ── Step 3: Generate embeddings in batches ──
  const embeddingsClient = new OpenAIEmbeddings({
    modelName: EMBEDDING_MODEL,
    openAIApiKey: config.openai_api_key,
  });

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    console.log(`🧮 Embedding batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / EMBEDDING_BATCH_SIZE)} (${batch.length} chunks)...`);

    const batchEmbeddings = await embeddingsClient.embedDocuments(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  console.log(`✅ Generated ${allEmbeddings.length} embeddings.`);

  // ── Step 4: Delete any existing chunks for this syllabus (re-index safe) ──
  await SyllabusChunkModel.deleteMany({ syllabusId });

  // ── Step 5: Store chunks in MongoDB ──
  const documents = chunks.map((text, index) => ({
    syllabusId,
    userId,
    text,
    embedding: allEmbeddings[index],
    chunkIndex: index,
  }));

  // Insert in batches to avoid hitting MongoDB document size limits
  const INSERT_BATCH_SIZE = 50;
  for (let i = 0; i < documents.length; i += INSERT_BATCH_SIZE) {
    const batch = documents.slice(i, i + INSERT_BATCH_SIZE);
    await SyllabusChunkModel.insertMany(batch);
  }

  console.log(`💾 Stored ${documents.length} chunks in SyllabusChunks collection.`);

  return { chunksStored: documents.length };
};

// ───────────────────────── Vector Search ─────────────────────────

/**
 * Perform MongoDB Atlas vector similarity search.
 * Falls back to text search if $vectorSearch is unavailable.
 */
const vectorSearch = async (
  queryEmbedding: number[],
  questionText: string,
  syllabusId: string,
  userId: string,
  topK: number = VECTOR_SEARCH_TOP_K
): Promise<Array<{ text: string; score: number }>> => {

  // ── Tier 1: MongoDB Atlas $vectorSearch ──
  try {
    console.log('🔍 Tier 1: Attempting $vectorSearch...');
    const results = await SyllabusChunkModel.aggregate([
      {
        $vectorSearch: {
          index: 'autoembed_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: topK * 10,
          limit: topK,
          filter: {
            syllabusId,
            userId,
          },
        },
      },
      {
        $project: {
          text: 1,
          score: { $meta: 'vectorSearchScore' },
          _id: 0,
        },
      },
    ]);

    if (results.length > 0) {
      console.log(`✅ Tier 1: Found ${results.length} chunks via vector search.`);
      return results;
    }
    console.warn('⚠️ Tier 1: $vectorSearch returned 0 results. Trying fallback...');
  } catch (vectorError: any) {
    console.warn(
      '⚠️ Tier 1: $vectorSearch failed (index may not exist). Error:',
      vectorError?.message
    );
  }

  // ── Tier 2: MongoDB $text search (requires text index on 'text' field) ──
  try {
    console.log('🔍 Tier 2: Attempting $text search...');
    const textResults = await SyllabusChunkModel.find({
      syllabusId,
      userId,
      $text: { $search: questionText },
    })
      .limit(topK)
      .select({ text: 1, _id: 0 })
      .lean();

    if (textResults.length > 0) {
      console.log(`✅ Tier 2: Found ${textResults.length} chunks via text search.`);
      return textResults.map((r) => ({ text: r.text, score: 0.5 }));
    }
    console.warn('⚠️ Tier 2: $text search returned 0 results. Trying basic fetch...');
  } catch (textError: any) {
    console.warn(
      '⚠️ Tier 2: $text search failed:',
      textError?.message
    );
  }

  // ── Tier 3: Basic find — just return all chunks for this syllabus (last resort) ──
  console.log('🔍 Tier 3: Fetching all chunks for syllabus as last resort...');
  const allChunks = await SyllabusChunkModel.find({ syllabusId, userId })
    .limit(topK)
    .select({ text: 1, _id: 0 })
    .lean();

  console.log(`📋 Tier 3: Found ${allChunks.length} total chunks for this syllabus.`);
  return allChunks.map((r) => ({ text: r.text, score: 0.1 }));
};

// ───────────────────────── LLM Chat (Groq → OpenAI failover) ─────────────────────────

const chatWithLLM = async (systemMessage: string, userMessage: string): Promise<string> => {
  // Try Groq first (free)
  if (config.groq_api_key) {
    try {
      const groqClient = new Groq({ apiKey: config.groq_api_key });
      const result = await groqClient.chat.completions.create({
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 2048,
      });
      return result.choices[0]?.message?.content || '';
    } catch (groqError: any) {
      console.warn('⚠️ Groq chat failed, falling back to OpenAI:', groqError?.message);
    }
  }

  // Fallback to OpenAI
  if (config.openai_api_key) {
    try {
      const openaiClient = new OpenAI({ apiKey: config.openai_api_key });
      const result = await openaiClient.chat.completions.create({
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
        model: 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 2048,
      });
      return result.choices[0]?.message?.content || '';
    } catch (openaiError: any) {
      console.error('❌ OpenAI chat also failed:', openaiError?.message);
    }
  }

  throw new AppError(
    httpStatus.INTERNAL_SERVER_ERROR,
    'AI services are currently unavailable. Please try again later.'
  );
};

// ───────────────────────── Main RAG Query Function ─────────────────────────

/**
 * Answer a student's question about their syllabus using RAG.
 * 1. Embed the question
 * 2. Vector search for relevant chunks
 * 3. Generate answer with LLM using retrieved context
 */
const getAnswerFromSyllabus = async (
  question: string,
  syllabusId: string,
  userId: string
): Promise<{ answer: string; sources: string[] }> => {
  // ── Step 0: Verify the study plan exists and belongs to the user ──
  const plan = await StudyPlanModel.findOne({ _id: syllabusId, user: userId });
  if (!plan) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'Study plan not found or you do not have access to it.'
    );
  }

  // ── Step 1: Embed the user's question ──
  if (!config.openai_api_key) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'OpenAI API key is required for query embeddings but is not configured.'
    );
  }

  const embeddingsClient = new OpenAIEmbeddings({
    modelName: EMBEDDING_MODEL,
    openAIApiKey: config.openai_api_key,
  });

  const questionEmbedding = await embeddingsClient.embedQuery(question);
  console.log(`🔍 Embedded question (${questionEmbedding.length} dimensions).`);

  // ── Step 2: Vector search for relevant chunks ──
  const relevantChunks = await vectorSearch(
    questionEmbedding,
    question, // Pass original question text for fallback search
    syllabusId,
    userId,
    VECTOR_SEARCH_TOP_K
  );

  if (relevantChunks.length === 0) {
    return {
      answer:
        "I couldn't find any relevant content in your syllabus to answer this question. Make sure the syllabus was uploaded correctly when you created your study plan.",
      sources: [],
    };
  }

  console.log(`📚 Found ${relevantChunks.length} relevant chunks.`);

  // ── Step 3: Build contextual prompt and get LLM answer ──
  const context = relevantChunks
    .map((chunk, i) => `[Source ${i + 1}]: ${chunk.text}`)
    .join('\n\n');

  const systemMessage = `You are a helpful academic assistant for a student. Your job is to answer questions about a syllabus document.

RULES:
- Answer ONLY based on the provided context from the syllabus.
- If the context does not contain enough information to answer, say "I don't have enough information in the syllabus to answer that question."
- Be concise but thorough. Use bullet points when listing topics.
- Reference specific parts of the syllabus when possible (e.g., "According to Module 3...").
- Never fabricate information that isn't in the context.
- If the student asks something unrelated to the syllabus, politely redirect them to syllabus-related questions.`;

  const userMessage = `STUDENT'S QUESTION: ${question}

SYLLABUS CONTEXT (retrieved from your uploaded document):
${context}

Answer the question based on the above syllabus context. Be helpful, accurate, and concise.`;

  const answer = await chatWithLLM(systemMessage, userMessage);

  const sources = relevantChunks.map((chunk) =>
    chunk.text.substring(0, 200) + (chunk.text.length > 200 ? '...' : '')
  );

  return { answer, sources };
};

// ───────────────────────── Delete Chunks (cleanup) ─────────────────────────

/**
 * Delete all vector chunks for a syllabus (e.g., when plan is deleted).
 */
const deleteChunksForSyllabus = async (syllabusId: string): Promise<number> => {
  const result = await SyllabusChunkModel.deleteMany({ syllabusId });
  return result.deletedCount;
};

export const ChatServices = {
  ingestSyllabusToVectorDB,
  getAnswerFromSyllabus,
  deleteChunksForSyllabus,
};
