/**
 * Login tracker — sliding window per detect failed login burst.
 *
 * Algoritmo:
 *   - In-memory Map<key, timestamps[]> dove key = `email|ipAddress`
 *   - Su ogni failure: push timestamp + filter window 5min
 *   - Se >= THRESHOLD (5) failed in window → reportSecurityEvent(failed_login_burst)
 *   - Reset key dopo report (no spam)
 */

import { reportSecurityEvent } from './sentinel-reporter.js';
import { logger } from '@/lib/logger.js';

const log = logger;

const WINDOW_MS = 5 * 60 * 1000; // 5min
const THRESHOLD = 5;
const RECENT_BURST_TTL_MS = 30 * 60 * 1000; // 30min suppression dopo report

const attempts = new Map<string, number[]>();
const recentlyReported = new Map<string, number>();

function cleanup(now: number): void {
  for (const [key, ts] of recentlyReported.entries()) {
    if (now - ts > RECENT_BURST_TTL_MS) recentlyReported.delete(key);
  }
}

export interface FailedLoginInput {
  email: string;
  tenantId: string;
  ipAddress?: string | undefined;
}

export function trackFailedLogin(input: FailedLoginInput): void {
  const now = Date.now();
  const key = `${input.tenantId}|${input.email}|${input.ipAddress ?? 'unknown'}`;

  cleanup(now);

  // Suppression window per evitare spam reports
  if (recentlyReported.has(key)) return;

  const arr = attempts.get(key) ?? [];
  const filtered = arr.filter((t) => now - t <= WINDOW_MS);
  filtered.push(now);
  attempts.set(key, filtered);

  if (filtered.length >= THRESHOLD) {
    log.warn?.({ key, count: filtered.length }, '[SECURITY] failed login burst detected');
    void reportSecurityEvent({
      eventType: 'failed_login_burst',
      severity: 'high',
      details: {
        email: input.email,
        ipAddress: input.ipAddress,
        attemptsInWindow: filtered.length,
        windowMinutes: WINDOW_MS / 60_000,
      },
    });
    recentlyReported.set(key, now);
    attempts.delete(key); // reset counter
  }
}
