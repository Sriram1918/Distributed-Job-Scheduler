import { query } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';

/**
 * Resource authorization helpers. Access flows through org membership:
 * a user may touch a project (and everything under it) only if they belong to
 * the organization that owns it. These run as small indexed lookups.
 */

export async function assertProjectAccess(
  userId: string,
  projectId: string,
): Promise<{ id: string; org_id: string; name: string }> {
  const { rows } = await query<{ id: string; org_id: string; name: string }>(
    `SELECT p.id, p.org_id, p.name
     FROM projects p
     JOIN memberships m ON m.org_id = p.org_id
     WHERE p.id = $1 AND m.user_id = $2`,
    [projectId, userId],
  );
  if (rows.length === 0) {
    // Distinguish "doesn't exist" from "not yours" without leaking existence.
    const exists = await query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    throw exists.rows.length ? forbidden('You do not have access to this project') : notFound('Project not found');
  }
  return rows[0]!;
}

export async function assertQueueAccess(
  userId: string,
  queueId: string,
): Promise<{ id: string; project_id: string; name: string }> {
  const { rows } = await query<{ id: string; project_id: string; name: string }>(
    `SELECT q.id, q.project_id, q.name
     FROM queues q
     JOIN projects p    ON p.id = q.project_id
     JOIN memberships m ON m.org_id = p.org_id
     WHERE q.id = $1 AND m.user_id = $2`,
    [queueId, userId],
  );
  if (rows.length === 0) throw notFound('Queue not found');
  return rows[0]!;
}

export async function assertOrgAccess(userId: string, orgId: string): Promise<void> {
  const { rows } = await query(
    `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  if (rows.length === 0) throw forbidden('You do not have access to this organization');
}
