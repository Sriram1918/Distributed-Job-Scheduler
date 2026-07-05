import { config } from '../config.js';
import { pool, waitForDb } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { markDeadWorkers, reclaimOrphans } from '../services/reaper.js';

process.env.SERVICE_NAME = 'reaper';
const log = logger.child({ component: 'reaper' });

async function tick(): Promise<void> {
  try {
    const dead = await markDeadWorkers(config.reaper.heartbeatTimeoutSeconds);
    const { requeued, deadLettered } = await reclaimOrphans();
    if (dead > 0 || requeued > 0 || deadLettered > 0) {
      log.info({ deadWorkers: dead, requeued, deadLettered }, 'Reaper tick');
    }
  } catch (err) {
    log.error({ err }, 'Reaper tick failed');
  }
}

async function main(): Promise<void> {
  await waitForDb();
  log.info(
    { intervalMs: config.reaper.intervalMs, timeoutSeconds: config.reaper.heartbeatTimeoutSeconds },
    'Reaper started',
  );

  let running = true;
  const loop = async () => {
    while (running) {
      await tick();
      await new Promise((r) => setTimeout(r, config.reaper.intervalMs));
    }
  };
  void loop();

  const shutdown = async () => {
    running = false;
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  log.error({ err }, 'Reaper failed to start');
  process.exit(1);
});
