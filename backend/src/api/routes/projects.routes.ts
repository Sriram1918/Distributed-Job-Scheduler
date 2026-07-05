import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { generateApiKey } from '../../lib/auth.js';
import { asyncHandler, parse } from '../http.js';
import { assertOrgAccess, assertProjectAccess } from '../access.js';

export const projectsRouter = Router();

/** List organizations the user belongs to. */
projectsRouter.get(
  '/organizations',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT o.id, o.name, m.role, o.created_at
       FROM memberships m JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY o.created_at`,
      [req.userId],
    );
    res.json({ data: rows });
  }),
);

const createOrgSchema = z.object({ name: z.string().min(1) });

projectsRouter.post(
  '/organizations',
  asyncHandler(async (req, res) => {
    const body = parse(createOrgSchema, req.body);
    const org = await withTransaction(async (c) => {
      const o = await c.query<{ id: string; name: string }>(
        `INSERT INTO organizations (name) VALUES ($1) RETURNING id, name`,
        [body.name],
      );
      await c.query(
        `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
        [req.userId, o.rows[0]!.id],
      );
      return o.rows[0]!;
    });
    res.status(201).json(org);
  }),
);

/** List projects across all orgs the user can access. */
projectsRouter.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT p.id, p.name, p.org_id, p.created_at,
              (SELECT count(*) FROM queues q WHERE q.project_id = p.id) AS queue_count
       FROM projects p
       JOIN memberships m ON m.org_id = p.org_id
       WHERE m.user_id = $1
       ORDER BY p.created_at DESC`,
      [req.userId],
    );
    res.json({ data: rows });
  }),
);

const createProjectSchema = z.object({
  name: z.string().min(1),
  organizationId: z.string().uuid(),
});

projectsRouter.post(
  '/projects',
  asyncHandler(async (req, res) => {
    const body = parse(createProjectSchema, req.body);
    await assertOrgAccess(req.userId!, body.organizationId);
    const { rows } = await query<{ id: string; name: string; api_key: string }>(
      `INSERT INTO projects (org_id, name, api_key) VALUES ($1, $2, $3)
       RETURNING id, name, api_key, org_id, created_at`,
      [body.organizationId, body.name, generateApiKey()],
    );
    res.status(201).json(rows[0]);
  }),
);

projectsRouter.get(
  '/projects/:projectId',
  asyncHandler(async (req, res) => {
    await assertProjectAccess(req.userId!, req.params.projectId!);
    const { rows } = await query(
      `SELECT id, name, org_id, api_key, created_at FROM projects WHERE id = $1`,
      [req.params.projectId],
    );
    res.json(rows[0]);
  }),
);
