export type RetryStrategy = 'fixed' | 'linear' | 'exponential';

export interface RetryPolicy {
  strategy: RetryStrategy;
  max_retries: number;
  base_delay_seconds: number;
  max_delay_seconds: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  strategy: 'exponential',
  max_retries: 3,
  base_delay_seconds: 10,
  max_delay_seconds: 3600,
};

/**
 * Delay before the next attempt, in seconds. `attempt` is the number of the
 * attempt that just FAILED (1-based), so the first retry uses attempt = 1.
 *
 *   fixed:        base
 *   linear:       base * attempt
 *   exponential:  base * 2^(attempt - 1)
 *
 * The result is capped at max_delay_seconds. A small +/-10% jitter is applied
 * to avoid the thundering-herd problem where many jobs retry in lockstep.
 */
export function computeBackoffSeconds(policy: RetryPolicy, attempt: number): number {
  const { strategy, base_delay_seconds: base, max_delay_seconds: max } = policy;
  let delay: number;
  switch (strategy) {
    case 'fixed':
      delay = base;
      break;
    case 'linear':
      delay = base * attempt;
      break;
    case 'exponential':
      delay = base * 2 ** (attempt - 1);
      break;
  }
  delay = Math.min(delay, max);
  const jitter = delay * 0.1 * (Math.random() * 2 - 1); // +/- 10%
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Whether a job that just failed on `attempt` still has retries left.
 * `maxRetries` is the effective cap (job-level override, defaulting to the
 * queue policy's max_retries at submit time).
 */
export function shouldRetry(maxRetries: number, attempt: number): boolean {
  return attempt <= maxRetries;
}
