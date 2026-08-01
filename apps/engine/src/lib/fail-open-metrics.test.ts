/**
 * fail-open-metrics — unit del modulo di osservabilità dei fail-open.
 *
 * Contract verificati (mutation-verify: ognuno fallirebbe se il modulo tornasse
 * al solo logger.warn pre-fix):
 *   • la METRICA è incrementata a OGNI scatto, con il tag control corretto e
 *     mai throttled (è il segnale alertabile);
 *   • il LOG security è throttled per fingerprint (control) — stesso control
 *     entro la finestra logga una volta; control diversi loggano separati;
 *   • control ed extra finiscono nel payload del log.
 *
 * Logger: manual mock condiviso (`__mocks__/logger.ts`) come impone il guard
 * no-inline-logger-mock — `loggerFor()` e `logger` puntano allo stesso spy.
 * `errorFingerprint` mockato = `fp:${context}` → il throttle è osservabile a
 * livello control (in prod il fingerprint reale aggiunge il tipo di errore).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const m = vi.hoisted(() => ({ counterInc: vi.fn() }));
vi.mock('@/lib/metrics-store.js', () => ({ counterInc: m.counterInc }));
vi.mock('@/lib/logger.js');

const { recordFailOpen, __resetFailOpenThrottleForTest } = await import('./fail-open-metrics.js');
// Il modulo chiama loggerFor(...) al top: lo spy logger condiviso è `logger`.
const { logger } = await import('@/lib/logger.js');
const warn = vi.mocked(logger.warn);

beforeEach(() => {
  vi.clearAllMocks();
  __resetFailOpenThrottleForTest();
});

describe('recordFailOpen — metrica', () => {
  it('incrementa flowforge_fail_open_total col tag control corretto', () => {
    recordFailOpen('execution_gate', new Error('db down'));
    expect(m.counterInc).toHaveBeenCalledTimes(1);
    const arg = m.counterInc.mock.calls[0]![0] as { name: string; tags: { control: string } };
    expect(arg.name).toBe('flowforge_fail_open_total');
    expect(arg.tags.control).toBe('execution_gate');
  });

  it('la metrica NON è throttled: 5 scatti identici → 5 incrementi', () => {
    for (let i = 0; i < 5; i += 1) recordFailOpen('vector_quota', new Error('same'));
    expect(m.counterInc).toHaveBeenCalledTimes(5);
  });
});

describe('recordFailOpen — log security throttled', () => {
  it('prima occorrenza logga, ripetizioni sullo stesso control entro finestra NO', () => {
    recordFailOpen('session_revocation.single', new Error('boom'), { tokenId: 'jti-1' });
    recordFailOpen('session_revocation.single', new Error('boom'), { tokenId: 'jti-2' });
    recordFailOpen('session_revocation.single', new Error('boom'), { tokenId: 'jti-3' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('control DIVERSI non si throttlano a vicenda', () => {
    recordFailOpen('vector_quota', new Error('x'));
    recordFailOpen('execution_gate', new Error('x'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('il control e gli extra finiscono nel payload del log, con err', () => {
    recordFailOpen('session_revocation.cutoff', new Error('down'), { sub: 'user-A' });
    const [payload, msg] = warn.mock.calls[0]! as [Record<string, unknown>, string];
    expect(payload.control).toBe('session_revocation.cutoff');
    expect(payload.sub).toBe('user-A');
    expect(payload.err).toBeInstanceOf(Error);
    expect(msg).toContain('FAIL-OPEN');
  });
});
