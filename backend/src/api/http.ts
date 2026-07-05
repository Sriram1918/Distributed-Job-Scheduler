import type { NextFunction, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../lib/errors.js';

// Augment Express Request with the authenticated user.
declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    userEmail?: string;
  }
}

/** Wrap an async route handler so thrown errors reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Parse & validate a payload with a zod schema, throwing a 400 on failure. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Validation failed', result.error.flatten());
  }
  return result.data;
}

export interface Pagination {
  limit: number;
  offset: number;
  page: number;
}

/** Standard ?page & ?limit parsing, clamped to sane bounds. */
export function pagination(query: Record<string, unknown>): Pagination {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? '20'), 10) || 20));
  return { limit, offset: (page - 1) * limit, page };
}
