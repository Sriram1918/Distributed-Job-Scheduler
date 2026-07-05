import { pool, waitForDb, withTransaction } from './pool.js';
import { hashPassword, generateApiKey } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { nextCronRun } from '../lib/cron.js';

/**
 * Idempotent-ish demo seed: a user, org, project, retry policies, a few queues,
 * and a spread of jobs (including flaky + always-failing ones so retries and
 * the Dead Letter Queue are populated, and a recurring cron definition).
 *
 * Login after seeding:  demo@example.com / password123
 */
async function seed(): Promise<void> {
  await waitForDb();

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', ['demo@example.com']);
  if (existing.rows.length) {
    logger.info('Seed already applied (demo user exists) — skipping');
    await pool.end();
    return;
  }

  await withTransaction(async (c) => {
    const pw = await hashPassword('password123');
    const user = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`,
      ['demo@example.com', pw, 'Demo User'],
    );
    const org = await c.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Demo Organization') RETURNING id`,
    );
    await c.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'owner')`, [
      user.rows[0]!.id,
      org.rows[0]!.id,
    ]);
    const project = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, api_key) VALUES ($1,'Demo Project',$2) RETURNING id`,
      [org.rows[0]!.id, generateApiKey()],
    );
    const projectId = project.rows[0]!.id;

    const expPolicy = await c.query<{ id: string }>(
      `INSERT INTO retry_policies (project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds)
       VALUES ($1,'Exponential x3','exponential',3,5,300) RETURNING id`,
      [projectId],
    );
    const fixedPolicy = await c.query<{ id: string }>(
      `INSERT INTO retry_policies (project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds)
       VALUES ($1,'Fixed 10s x2','fixed',2,10,10) RETURNING id`,
      [projectId],
    );

    const emails = await c.query<{ id: string }>(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit, retry_policy_id)
       VALUES ($1,'emails',10,5,$2) RETURNING id`,
      [projectId, expPolicy.rows[0]!.id],
    );
    const webhooks = await c.query<{ id: string }>(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit, retry_policy_id)
       VALUES ($1,'webhooks',5,3,$2) RETURNING id`,
      [projectId, fixedPolicy.rows[0]!.id],
    );
    const emailsId = emails.rows[0]!.id;
    const webhooksId = webhooks.rows[0]!.id;

    // A spread of immediate jobs.
    for (let i = 0; i < 10; i++) {
      await c.query(
        `INSERT INTO jobs (queue_id, type, task, payload, status, priority, max_retries)
         VALUES ($1,'immediate','send_email',$2,'queued',0,3)`,
        [emailsId, JSON.stringify({ to: `user${i}@example.com` })],
      );
    }
    for (let i = 0; i < 5; i++) {
      await c.query(
        `INSERT INTO jobs (queue_id, type, task, payload, status, priority, max_retries)
         VALUES ($1,'immediate','flaky',$2,'queued',0,3)`,
        [webhooksId, JSON.stringify({ failRate: 0.6 })],
      );
    }
    // Guaranteed dead-letter fodder.
    for (let i = 0; i < 2; i++) {
      await c.query(
        `INSERT INTO jobs (queue_id, type, task, payload, status, priority, max_retries)
         VALUES ($1,'immediate','always_fail',$2,'queued',0,2)`,
        [webhooksId, JSON.stringify({ reason: 'seeded permanent failure' })],
      );
    }
    // A delayed job (visible in 30s).
    await c.query(
      `INSERT INTO jobs (queue_id, type, task, payload, status, priority, available_at, max_retries)
       VALUES ($1,'delayed','send_email',$2,'scheduled',0, now() + interval '30 seconds',3)`,
      [emailsId, JSON.stringify({ to: 'delayed@example.com' })],
    );
    // A recurring definition (every minute).
    await c.query(
      `INSERT INTO scheduled_jobs (queue_id, name, cron_expr, timezone, task, payload, next_run_at)
       VALUES ($1,'heartbeat-email','* * * * *','UTC','send_email',$2,$3)`,
      [emailsId, JSON.stringify({ to: 'cron@example.com' }), nextCronRun('* * * * *', 'UTC', new Date())],
    );

    logger.info({ projectId }, 'Seed complete — login: demo@example.com / password123');
  });

  await pool.end();
}

seed().catch((err) => {
  logger.error({ err }, 'Seed failed');
  process.exit(1);
});
