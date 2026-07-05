import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/** 404 for unmatched routes. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

/** Central error translator: AppError -> its status; everything else -> 500. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Unique-violation from Postgres -> 409.
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    res.status(409).json({
      error: { code: 'conflict', message: 'Resource already exists' },
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}
