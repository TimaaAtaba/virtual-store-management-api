/**
 * Wraps async controllers so rejected promises reach the global error handler
 * instead of crashing the process (no try/catch duplication in every function).
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
