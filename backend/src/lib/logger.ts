import pino from 'pino';

/**
 * Structured JSON logger shared by every service. In development we pretty
 * print if the (optional) transport is available; in containers we emit plain
 * JSON lines that a log aggregator can parse.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'backend' },
});

export type Logger = typeof logger;
