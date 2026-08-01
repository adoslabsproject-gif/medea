/**
 * Adapter — SystemClock.
 *
 * Implementazione "production" del port IClock. Niente magia: `new Date()`,
 * `Date.now()`. Test sostituiscono con FakeClock.
 */

import type { IClock } from '@/services/janitor/ports/index.js';

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
  epochMs(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}
