import parser from 'cron-parser';

/**
 * Compute the next fire time for a cron expression after `from`.
 * Returns null if the expression is invalid.
 */
export function nextCronRun(
  cronExpr: string,
  timezone = 'UTC',
  from: Date = new Date(),
): Date | null {
  try {
    const interval = parser.parseExpression(cronExpr, {
      currentDate: from,
      tz: timezone,
    });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(cronExpr: string): boolean {
  try {
    parser.parseExpression(cronExpr);
    return true;
  } catch {
    return false;
  }
}
