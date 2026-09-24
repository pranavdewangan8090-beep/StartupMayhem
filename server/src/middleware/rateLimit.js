import rateLimit from 'express-rate-limit';

// Generous general limit: ~30 phones polling every 4s is about 8 req/s total,
// well under this per-IP limit (most phones will be on different IPs/NAT anyway).
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Login is worth protecting against brute force, but ~30 teams on the same
// venue WiFi can share one public IP behind NAT, so the limit needs to stay
// generous enough for real traffic. 40/min per IP is still hopeless for
// guessing an 8-character random password, but won't lock out a whole room.
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many login attempts. Wait a minute and try again.' },
});

// A slightly tighter limit for state-changing game actions, per IP.
export const actionLimiter = rateLimit({
  windowMs: 10 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
