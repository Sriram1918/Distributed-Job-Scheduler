import { describe, it, expect } from 'vitest';
import { computeBackoffSeconds, shouldRetry, type RetryPolicy } from '../src/lib/retry.js';

const base: RetryPolicy = { strategy: 'fixed', max_retries: 3, base_delay_seconds: 10, max_delay_seconds: 1000 };

describe('retry backoff', () => {
  it('fixed strategy returns a constant base delay', () => {
    const p = { ...base, strategy: 'fixed' as const };
    for (const attempt of [1, 2, 3]) {
      const d = computeBackoffSeconds(p, attempt);
      expect(d).toBeGreaterThanOrEqual(9);   // 10 ±10% jitter
      expect(d).toBeLessThanOrEqual(11);
    }
  });

  it('linear strategy grows with the attempt number', () => {
    const p = { ...base, strategy: 'linear' as const, base_delay_seconds: 5 };
    // attempt 1 ~5, attempt 4 ~20 (allow jitter)
    expect(computeBackoffSeconds(p, 1)).toBeLessThan(computeBackoffSeconds(p, 4) + 3);
    expect(computeBackoffSeconds(p, 4)).toBeGreaterThan(15);
  });

  it('exponential strategy doubles each attempt', () => {
    const p = { ...base, strategy: 'exponential' as const, base_delay_seconds: 1, max_delay_seconds: 10000 };
    // attempt 1 -> ~1, attempt 5 -> ~16
    expect(computeBackoffSeconds(p, 1)).toBeLessThanOrEqual(2);
    expect(computeBackoffSeconds(p, 5)).toBeGreaterThan(12);
  });

  it('caps the delay at max_delay_seconds', () => {
    const p = { ...base, strategy: 'exponential' as const, base_delay_seconds: 100, max_delay_seconds: 120 };
    // 100 * 2^9 would be huge; must be capped near 120 (+ jitter).
    expect(computeBackoffSeconds(p, 10)).toBeLessThanOrEqual(132);
  });

  it('shouldRetry respects the max retry count', () => {
    expect(shouldRetry(3, 1)).toBe(true);
    expect(shouldRetry(3, 3)).toBe(true);
    expect(shouldRetry(3, 4)).toBe(false);
    expect(shouldRetry(0, 1)).toBe(false); // no retries allowed
  });
});
