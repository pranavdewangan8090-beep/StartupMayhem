/** Blocks the request unless req.user.role is one of `roles`. Use after requireAuth. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not have access to this.' });
    }
    next();
  };
}
