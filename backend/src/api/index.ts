import { config } from '../config.js';
import { waitForDb, pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { createApp } from './server.js';

process.env.SERVICE_NAME = 'api';

async function main(): Promise<void> {
  await waitForDb();
  const app = createApp();
  const server = app.listen(config.api.port, () => {
    logger.info({ port: config.api.port }, 'API listening');
  });

  const shutdown = () => {
    logger.info('API shutting down');
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'API failed to start');
  process.exit(1);
});
