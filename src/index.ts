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

// Export a default handler — Vercel calls this for every incoming request.
export default async function handler(req: any, res: any) {
  await connectDB();
  return app(req, res);
}
