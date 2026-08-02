import * as Sentry from "@sentry/nextjs";

/**
 * Report errors without leaking PII.
 * - In production, prefers Sentry if configured.
 * - In dev, logs to console.
 */
export function reportError(err: unknown, context?: Record<string, any>) {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
  if (dsn) {
    try {
      Sentry.captureException(err, { extra: context || {} });
      return;
    } catch {
      // fallthrough
    }
  }
  // eslint-disable-next-line no-console
  console.error(err);
}
