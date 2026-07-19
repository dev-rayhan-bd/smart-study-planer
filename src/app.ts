import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import router from './app/routes/index';
import globalErrorHandler from './app/middleware/globalErrorHandler';
import notFound from './app/middleware/notFound';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
const app: Application = express();



// --- HIGH SECURITY MIDDLEWARES ---
app.use(helmet()); // HTTP headers security
// Custom NoSQL sanitize — compatible with Express v5
app.use((req: Request, _res: Response, next) => {
  const sanitize = (obj: Record<string, unknown>) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const key of Object.keys(obj)) {
        if (key.startsWith('$') || key.includes('.')) {
          delete obj[key];
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitize(obj[key] as Record<string, unknown>);
        }
      }
    }
  };

  if (req.body) sanitize(req.body as Record<string, unknown>);
  if (req.query) sanitize(req.query as Record<string, unknown>);
  if (req.params) sanitize(req.params as Record<string, unknown>);
  next();
});

// --- RATE LIMITING ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, //14 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true, 
  legacyHeaders: false, 
});
app.use('/api', limiter); 

app.use(express.json({ limit: '10kb' })); // bosy size limnit 10kb, to prevent DoS attacks

// Now apply JSON parser for all other routes
app.use(express.json());
app.use(cookieParser());

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'https://sylabix-frontend.vercel.app'
      
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  })
);

app.use(morgan('dev'));
app.use('/api/v1', router);

app.get('/', (req: Request, res: Response) => {
  res.send('Currently API - Server is Breathing...');
});

app.use(globalErrorHandler);
app.use(notFound);

export default app;