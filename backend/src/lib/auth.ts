import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

export interface JwtPayload {
  userId: string;
  email: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.api.jwtSecret, {
    expiresIn: config.api.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.api.jwtSecret) as JwtPayload;
}

/** Generate an opaque API key for programmatic job submission. */
export function generateApiKey(): string {
  return 'sk_' + randomBytes(24).toString('hex');
}
