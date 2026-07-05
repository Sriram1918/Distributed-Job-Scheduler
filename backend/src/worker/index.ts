import { config } from '../config.js';
import { waitForDb, pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { Worker } from './worker.js';

process.env.SERVICE_NAME = 'worker';

async function main(): Promise<void> {
  await waitForDb();

  const worker = new Worker({
    concurrency: config.worker.concurrency,
    pollIntervalMs: config.worker.pollIntervalMs,
    leaseSeconds: config.worker.leaseSeconds,
    heartbeatIntervalMs: config.worker.heartbeatIntervalMs,
    name: config.worker.name,
  });

  await worker.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await worker.shutdown();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
