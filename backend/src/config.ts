import 'dotenv/config';

/**
 * Central, typed configuration. Reads from environment variables (loaded from
 * a local .env in development; injected by docker-compose in containers).
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer, got "${v}"`);
  return n;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ??
    'postgres://scheduler:scheduler_pw@localhost:5432/job_scheduler',

  api: {
    port: int('API_PORT', 4000),
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 5),
    pollIntervalMs: int('POLL_INTERVAL_MS', 1000),
    leaseSeconds: int('LEASE_SECONDS', 60),
    heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 5000),
    name: process.env.WORKER_NAME, // optional friendly name
  },

  scheduler: {
    intervalMs: int('SCHEDULER_INTERVAL_MS', 2000),
  },

  reaper: {
    intervalMs: int('REAPER_INTERVAL_MS', 5000),
    heartbeatTimeoutSeconds: int('HEARTBEAT_TIMEOUT_SECONDS', 30),
  },
} as const;

export { required };
