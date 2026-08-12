import mongoose from 'mongoose';
import config from './app/config';
import seedAdmin from './app/DB';
import app from './app';

// Vercel Serverless Functions pre-parse the body by default, which causes Express's
// body-parser to hang indefinitely waiting for a stream that's already consumed.
// Disabling bodyParser here allows Express to handle it natively.
export const config = {
  api: {
    bodyParser: false,
  },
};

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
  try {
    await connectDB();
  } catch (err: any) {
    // If DB connection fails, send the error to the browser so we can debug it
    console.error('DB Connection Error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to connect to database or seed admin',
      error: err?.message || String(err),
      stack: err?.stack,
    });
  }

  // Return a promise that resolves when the response finishes
  // This prevents Vercel from terminating the function prematurely
  return new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
    app(req, res);
  });
}
