/**
 * Application error with an HTTP status and a stable machine-readable code.
 * Thrown anywhere in the request path and translated to JSON by the central
 * error handler.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') =>
  new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Resource not found') =>
  new AppError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) =>
  new AppError(409, 'conflict', msg, details);
