/**
 * Validates req.body/req.params/req.query against a zod schema. On failure,
 * responds 400 without ever calling the route handler — every route's input
 * is checked before it reaches business logic.
 */
export function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'Invalid request.',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req[part] = result.data;
    next();
  };
}
