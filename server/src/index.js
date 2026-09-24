import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { verifyOrigin } from './middleware/csrf.js';
import authRoutes from './routes/auth.js';
import playerRoutes from './routes/player.js';
import actionCardRoutes from './routes/actionCards.js';
import marketRoutes from './routes/market.js';
import mayhemRoutes from './routes/mayhem.js';
import adminRoutes from './routes/admin.js';
import superAdminRoutes from './routes/superAdmin.js';

const app = express();

app.set('trust proxy', 1); // needed for correct rate-limit / secure-cookie behavior behind a host's proxy
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(generalLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// CSRF defense: every state-changing request must come from an allowed
// origin. Applied after /health (harmless, no auth) so uptime checks aren't
// affected, and before every route below that can mutate data.
app.use(verifyOrigin);

app.use('/api/auth', authRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/action-cards', actionCardRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/mayhem', mayhemRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/super-admin', superAdminRoutes);

// last-resort handler: never leak stack traces to the client
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong.' });
});

app.listen(config.port, () => {
  console.log(`Startup Mayhem server listening on :${config.port}`);
});
