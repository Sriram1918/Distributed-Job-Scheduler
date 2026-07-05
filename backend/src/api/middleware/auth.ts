import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../../lib/auth.js';
import { unauthorized } from '../../lib/errors.js';

/**
 * Require a valid Bearer JWT. Populates req.userId / req.userEmail.
 * Membership/ownership checks happen per-resource in the route handlers.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('Missing Bearer token');
  }
  try {
    const payload = verifyToken(header.slice('Bearer '.length));
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}
