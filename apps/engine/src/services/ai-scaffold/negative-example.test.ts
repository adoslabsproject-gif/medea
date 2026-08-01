/**
 * captureRejectedScaffold — negative-example learning (gap #10 masterplan).
 *
 * Bug-bounty: insert+updateOutcome('rejected') col workflow rifiutato e i
 * motivi; opt-out (insert→null) = no updateOutcome; fail-soft TOTALE (errori
 * dello store NON propagano, la richiesta è già un 502).
 */
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({ insert: vi.fn(), updateOutcome: vi.fn() }));
vi.mock('@/services/ai-interactions.service.js', () => ({
  AIInteractionsService: class {
    insert = svc.insert;
    updateOutcome = svc.updateOutcome;
  },
}));
vi.mock('@/lib/logger.js');

import { captureRejectedScaffold } from './negative-example.js';

const baseArgs = () => ({
  tenantId: 'tenant-1',
  goal: 'crea un workflow che fa X',
  rejectedWorkflow: { nodes: [{ id: 'n1' }], edges: [] },
  criticalIssues: [
    { code: 'ORPHAN_TRIGGER', message: 'trigger non collegato' },
    { code: 'SWITCH_NO_DEFAULT', message: 'switch senza default' },
  ],
  model: 'claude-x',
  latencyMs: 1234,
});

beforeEach(() => {
  svc.insert.mockReset();
  svc.updateOutcome.mockReset();
});

describe('captureRejectedScaffold — happy path', () => {
  it('insert con interactionType workflow_from_text + prompt + patch + reasons', () => {
    svc.insert.mockReturnValue('int-1');
    captureRejectedScaffold(baseArgs());
    expect(svc.insert).toHaveBeenCalledTimes(1);
    const arg = svc.insert.mock.calls[0]![0];
    expect(arg.interactionType).toBe('workflow_from_text');
    expect(arg.context.tenantId).toBe('tenant-1');
    expect(arg.request.prompt).toBe('crea un workflow che fa X');
    // il workflow rifiutato è il "negative" nella patch
    expect(arg.response.patch).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
    // i motivi del rifiuto sono nel message
    expect(arg.response.message).toContain('ORPHAN_TRIGGER');
    expect(arg.response.message).toContain('SWITCH_NO_DEFAULT');
    expect(arg.response.model).toBe('claude-x');
  });

  it('marca l\'outcome a "rejected" sull\'id ritornato', () => {
    svc.insert.mockReturnValue('int-42');
    captureRejectedScaffold(baseArgs());
    expect(svc.updateOutcome).toHaveBeenCalledWith({
      interactionId: 'int-42',
      tenantId: 'tenant-1',
      outcome: 'rejected',
    });
  });
});

describe('captureRejectedScaffold — opt-out + fail-soft', () => {
  it('insert ritorna null (training capture disabilitato) → NESSUN updateOutcome', () => {
    svc.insert.mockReturnValue(null);
    captureRejectedScaffold(baseArgs());
    expect(svc.updateOutcome).not.toHaveBeenCalled();
  });

  it('🚨 insert lancia → NON propaga (fail-soft, la richiesta è già un 502)', () => {
    svc.insert.mockImplementation(() => { throw new Error('db down'); });
    expect(() => { captureRejectedScaffold(baseArgs()); }).not.toThrow();
  });

  it('🚨 updateOutcome lancia → NON propaga', () => {
    svc.insert.mockReturnValue('int-1');
    svc.updateOutcome.mockImplementation(() => { throw new Error('boom'); });
    expect(() => { captureRejectedScaffold(baseArgs()); }).not.toThrow();
  });

  it('model vuoto → fallback "unknown"', () => {
    svc.insert.mockReturnValue('int-1');
    captureRejectedScaffold({ ...baseArgs(), model: '' });
    expect(svc.insert.mock.calls[0]![0].response.model).toBe('unknown');
  });

  it('cap a 10 issue nel message (no payload gigante)', () => {
    svc.insert.mockReturnValue('int-1');
    const many = Array.from({ length: 25 }, (_, i) => ({ code: `C${String(i)}`, message: `m${String(i)}` }));
    captureRejectedScaffold({ ...baseArgs(), criticalIssues: many });
    const msg = svc.insert.mock.calls[0]![0].response.message as string;
    expect(msg).toContain('C0');
    expect(msg).toContain('C9');
    expect(msg).not.toContain('C10');
  });
});

describe('🔒 wiring in singleshot — cattura SOLO al reject finale', () => {
  // Source-inspection: captureRejectedScaffold deve stare dentro il guard
  // `if (attemptIdx >= MAX_RETRIES)`, altrimenti registreremmo anche i reject
  // intermedi (auto-corretti) inquinando il dataset con falsi negative.
  it('captureRejectedScaffold è chiamato dentro `if (attemptIdx >= MAX_RETRIES)`', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'singleshot.service.ts'), 'utf8');
    const idxGuard = src.indexOf('if (attemptIdx >= MAX_RETRIES)');
    const idxCall = src.indexOf('captureRejectedScaffold({');
    expect(idxGuard).toBeGreaterThan(-1);
    expect(idxCall).toBeGreaterThan(idxGuard);
    // nessuna chiusura di branch tra il guard e la chiamata (resta annidata)
    expect(src.slice(idxGuard, idxCall)).not.toContain('}\n');
  });
});
