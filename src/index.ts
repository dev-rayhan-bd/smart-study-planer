import mongoose from 'mongoose';
import config from './app/config';
import seedAdmin from './app/DB';
import app from './app';

// ── Vercel Serverless Entry ─────────────────────────────────────────────────
// Vercel serverless functions receive (req, res) directly — they do NOT
// need app.listen().  We connect to MongoDB lazily and cache the connection
// across warm invocations so cold-starts stay fast.

let cachedConnection: typeof mongoose | null = null;

async function connectDB() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  cachedConnection = await mongoose.connect(config.database_url as string);
  await seedAdmin();
  return cachedConnection;
}

export default async function handler(req: any, res: any) {
  await connectDB();

  // Return a promise that resolves when the response finishes
  // This prevents Vercel from terminating the function prematurely
  return new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
    app(req, res);
  });
}
