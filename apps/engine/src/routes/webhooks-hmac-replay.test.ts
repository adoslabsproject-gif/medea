/**
 * AUDIT FIX WE-4 (2026-06-09 CRITICAL) — REGRESSION GUARD:
 *
 * Invariante:
 *   "Webhook HMAC con `hmacTimestampHeader` configurato deve rifiutare:
 *    1. timestamp mancante
 *    2. timestamp scaduto (> tolerance)
 *    3. signature replicata (replay) entro la TTL window 10min
 *    4. signature firmata su body solo (legacy format) quando si aspettava ts.body"
 *
 * Pre-fix bug:
 *   HMAC su body solo → 1 signed POST captured = replay infinito (un webhook
 *   "crea ordine" firmato = 1000 ordini duplicati nello stesso secondo).
 *
 * Post-fix: tolerance window ±300s default + dedup LRU 10min (10k entries).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('@/lib/logger.js');
vi.mock('@/services/workflow.service.js', () => ({ WorkflowService: class {} }));
vi.mock('@/services/run.service.js', () => ({ RunService: class {} }));
vi.mock('@/lib/safe-parse-json.js', () => ({ safeParseJson: vi.fn() }));
vi.mock('@/executors/wait.js', () => ({ resumeWait: vi.fn() }));
vi.mock('@/services/test-event-bus.service.js', () => ({ publishTestEvent: vi.fn() }));
vi.mock('@/executors/webhook-respond.js', () => ({
  WEBHOOK_RESPONSE_KEY: 'response',
}));

import { authorize, __resetWebhookSignatureCache, webhookSignatureSeen } from './webhooks.js';
import type { CanvasNode } from '@medea/engine-core-schema';

const SECRET = 'shared-secret-min-32-char-aaaaaaaaaa';

function makeNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'wh-1',
    type: 'trigger_webhook',
    config: {
      authMode: 'hmac-signature',
      hmacSecret: SECRET,
      hmacHeader: 'x-sig',
      hmacAlgo: 'sha256',
      ...extra,
    },
  } as unknown as CanvasNode;
}

beforeEach(() => {
  __resetWebhookSignatureCache();
});

function signTsBody(ts: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
}
function signBody(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('🚨 [REGRESSION WE-4] Webhook HMAC replay protection', () => {
  it('🚨 modalità timestamp NON configurata → legacy accept (back-compat) ma con warn log', () => {
    const node = makeNode();
    const body = JSON.stringify({ event: 'order.created' });
    const sig = signBody(body);
    const ok = authorize(node, { 'x-sig': sig }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(true);
  });

  it('🚨 timestamp header configurato + ts valid + sig su ts.body → accept', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts' });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event: 'order.created' });
    const sig = signTsBody(ts, body);
    const ok = authorize(node, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(true);
  });

  it('🚨 timestamp header configurato MA mancante → reject', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts' });
    const body = '{}';
    const sig = signTsBody(String(Math.floor(Date.now() / 1000)), body);
    const ok = authorize(node, { 'x-sig': sig }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(false);
  });

  it('🚨 timestamp out-of-tolerance (1 ora vecchio) → reject', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts', hmacTimestampToleranceSec: 300 });
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    const body = '{}';
    const sig = signTsBody(oldTs, body);
    const ok = authorize(node, { 'x-sig': sig, 'x-ts': oldTs }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(false);
  });

  it('🚨 timestamp future-dated (1 ora avanti) → reject (clock skew)', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts', hmacTimestampToleranceSec: 300 });
    const futureTs = String(Math.floor(Date.now() / 1000) + 3600);
    const body = '{}';
    const sig = signTsBody(futureTs, body);
    const ok = authorize(node, { 'x-sig': sig, 'x-ts': futureTs }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(false);
  });

  /**
   * 🚨 IL BUG PRE-FIX: stessa signature replicata 1000 volte = 1000 ordini.
   * Post-fix: la seconda call con stesso (nodeId, signature) → reject.
   */
  it('🚨 [REGRESSION WE-4] replay attack: stesso signed POST 2x → 2a chiamata reject', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts' });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event: 'order.created', amount: 100 });
    const sig = signTsBody(ts, body);

    // Prima call → accept
    const first = authorize(node, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1');
    expect(first).toBe(true);

    // Seconda call IDENTICA → reject (replay)
    const second = authorize(node, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1');
    expect(second).toBe(false);
  });

  it('🚨 [REGRESSION WE-4] signature dedup per-nodeId scope (no cross-webhook leak)', () => {
    const nodeA = makeNode({ hmacTimestampHeader: 'x-ts' });
    nodeA.id = 'wh-A';
    const nodeB = makeNode({ hmacTimestampHeader: 'x-ts' });
    nodeB.id = 'wh-B';
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{}';
    const sig = signTsBody(ts, body);
    // Stessa signature può essere accettata su 2 webhook diversi (uno per nodo).
    expect(authorize(nodeA, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1')).toBe(true);
    expect(authorize(nodeB, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-2')).toBe(true);
    // Ma replay sullo stesso nodo → rejected
    expect(authorize(nodeA, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1')).toBe(false);
  });

  it('🚨 signed payload format "body" (GitHub-style) configurabile', () => {
    const node = makeNode({
      hmacTimestampHeader: 'x-ts',
      hmacSignedPayloadFormat: 'body',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event: 'push' });
    // sign su body solo (no ts)
    const sig = signBody(body);
    const ok = authorize(node, { 'x-sig': sig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(true);
  });

  it('🚨 signature manomessa (1 byte cambiato) → reject', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts' });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{}';
    const sig = signTsBody(ts, body);
    // flip 1 char
    const tamperedSig = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    const ok = authorize(node, { 'x-sig': tamperedSig, 'x-ts': ts }, body, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(false);
  });

  it('🚨 body manomesso post-signature → reject', () => {
    const node = makeNode({ hmacTimestampHeader: 'x-ts' });
    const ts = String(Math.floor(Date.now() / 1000));
    const origBody = JSON.stringify({ event: 'order', amount: 10 });
    const sig = signTsBody(ts, origBody);
    const tamperedBody = JSON.stringify({ event: 'order', amount: 99999 });
    const ok = authorize(node, { 'x-sig': sig, 'x-ts': ts }, tamperedBody, '', '1.2.3.4', 'wf-1');
    expect(ok).toBe(false);
  });
});

describe('🚨 [REGRESSION WE-4] webhookSignatureSeen LRU dedup', () => {
  it('🚨 prima volta → false (not seen)', () => {
    expect(webhookSignatureSeen('n1', 'sig-abc')).toBe(false);
  });

  it('🚨 seconda volta entro TTL → true (replay)', () => {
    webhookSignatureSeen('n1', 'sig-abc');
    expect(webhookSignatureSeen('n1', 'sig-abc')).toBe(true);
  });

  it('🚨 nodeId diverso → false (scope per-node)', () => {
    webhookSignatureSeen('n1', 'sig-abc');
    expect(webhookSignatureSeen('n2', 'sig-abc')).toBe(false);
  });

  it('🚨 reset cache → false di nuovo', () => {
    webhookSignatureSeen('n1', 'sig-abc');
    __resetWebhookSignatureCache();
    expect(webhookSignatureSeen('n1', 'sig-abc')).toBe(false);
  });
});
