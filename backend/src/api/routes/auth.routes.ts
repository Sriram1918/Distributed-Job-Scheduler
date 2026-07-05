import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, query } from '../../db/pool.js';
import { hashPassword, verifyPassword, signToken } from '../../lib/auth.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { asyncHandler, parse } from '../http.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
  organizationName: z.string().min(1).optional(),
});

/** Register a user and bootstrap a default organization they own. */
authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const passwordHash = await hashPassword(body.password);

    const result = await withTransaction(async (c) => {
      const existing = await c.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
      if (existing.rows.length) throw badRequest('Email already registered');

      const user = await c.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
         RETURNING id, email`,
        [body.email, passwordHash, body.name ?? null],
      );
      const org = await c.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
        [body.organizationName ?? `${body.name ?? body.email}'s Organization`],
      );
      await c.query(
        `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
        [user.rows[0]!.id, org.rows[0]!.id],
      );
      return { userId: user.rows[0]!.id, email: user.rows[0]!.email, orgId: org.rows[0]!.id };
    });

    const token = signToken({ userId: result.userId, email: result.email });
    res.status(201).json({ token, user: { id: result.userId, email: result.email }, organizationId: result.orgId });
  }),
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const { rows } = await query<{ id: string; email: string; password_hash: string }>(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [body.email],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw unauthorized('Invalid email or password');
    }
    const token = signToken({ userId: user.id, email: user.email });
    res.json({ token, user: { id: user.id, email: user.email } });
  }),
);

/** Current user + the organizations they belong to. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT o.id, o.name, m.role
       FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1
       ORDER BY o.created_at`,
      [req.userId],
    );
    res.json({ user: { id: req.userId, email: req.userEmail }, organizations: rows });
  }),
);
