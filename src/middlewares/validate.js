/**
 * Zod validation middleware.
 * Uses safeParse() (as required) and returns 400 with a detailed list of
 * problems when the incoming data is invalid. On success the request body is
 * replaced by the parsed (and sanitized) data.
 */
const validate = (schema, source = "body") => (req, res, next) => {
  const result = schema.safeParse(req[source]);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || source,
      message: issue.message,
    }));

    return res.status(400).json({
      success: false,
      message: "Validation failed (Zod)",
      errors,
    });
  }

  req[source] = result.data;
  next();
};

module.exports = validate;
