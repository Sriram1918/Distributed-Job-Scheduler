/**
 * Task registry. In a real system these would call out to business logic;
 * here they are small, deterministic-ish handlers so the scheduler is fully
 * demonstrable end-to-end and the retry/DLQ paths are easy to exercise.
 *
 * A handler receives the job payload and returns any JSON-serialisable result.
 * Throwing marks the attempt as failed (which triggers retry/backoff/DLQ).
 */
export type TaskHandler = (
  payload: Record<string, unknown>,
  ctx: { jobId: string; attempt: number; log: (msg: string) => Promise<void> },
) => Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const tasks: Record<string, TaskHandler> = {
  /** Pretend to send an email. */
  async send_email(payload, ctx) {
    await ctx.log(`Sending email to ${payload.to ?? 'unknown'}`);
    await sleep(Number(payload.durationMs ?? 300));
    return { sent: true, to: payload.to };
  },

  /** Pretend to perform an HTTP request. */
  async http_request(payload, ctx) {
    await ctx.log(`Requesting ${payload.method ?? 'GET'} ${payload.url}`);
    await sleep(Number(payload.durationMs ?? 200));
    return { status: 200, url: payload.url };
  },

  /** Sleep for payload.ms — handy for exercising concurrency limits. */
  async sleep(payload) {
    await sleep(Number(payload.ms ?? 1000));
    return { slept: Number(payload.ms ?? 1000) };
  },

  /** Always throws — used to demonstrate retries and the Dead Letter Queue. */
  async always_fail(payload) {
    throw new Error(String(payload.reason ?? 'intentional failure'));
  },

  /** Fails with probability payload.failRate, else succeeds — flaky task. */
  async flaky(payload, ctx) {
    const failRate = Number(payload.failRate ?? 0.5);
    if (Math.random() < failRate) {
      await ctx.log(`Flaky task failed on attempt ${ctx.attempt}`);
      throw new Error('flaky failure');
    }
    return { ok: true, attempt: ctx.attempt };
  },
};

export function getTaskHandler(name: string): TaskHandler | undefined {
  return tasks[name];
}
