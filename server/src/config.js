// Central place for reading environment variables so the rest of the app never
// touches process.env directly. Fails loudly at boot if something required is
// missing, instead of silently running with an undefined secret.
import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim());

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  // comma-separated list of allowed origins for CORS
  corsOrigins,
  // CORS_ORIGINS=* accepts a request from any origin — convenient when
  // phones keep landing on a different LAN IP, but it also disables the
  // Origin-based CSRF check below (see verifyOrigin), so only use it on a
  // trusted network for a short event, not for anything left running long-term.
  corsAllowAll: corsOrigins.includes('*'),
};
