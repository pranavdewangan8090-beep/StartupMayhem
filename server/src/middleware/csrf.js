import { config } from '../config.js';

/**
 * Cookie-based auth needs SameSite=None in production (the frontend and
 * backend are hosted on different domains), which by itself allows a
 * malicious third-party page to trigger state-changing requests using the
 * browser's saved cookie (CSRF). As a second, independent check, every
 * non-GET request must carry an Origin (or Referer) header that matches one
 * of the configured allowed origins. A same-site browser request always
 * sends this; a cross-site CSRF page cannot spoof it.
 */
export function verifyOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // CORS_ORIGINS=* means this check is intentionally disabled — see the
  // corsAllowAll comment in config.js for the tradeoff that implies.
  if (config.corsAllowAll) return next();

  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  if (!origin || !config.corsOrigins.includes(origin)) {
    return res.status(403).json({ error: 'BAD_ORIGIN', message: 'Request origin not allowed.' });
  }
  next();
}
