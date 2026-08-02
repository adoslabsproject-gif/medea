/**
 * Bug-bounty UNIT — services/community-nodes-events.ts (audit coverage
 * 2026-06-12: 0%). Pub/sub minimale per il refresh ETag della palette nodi.
 * Pinniamo: emit chiama TUTTI i listener, un listener che lancia NON blocca
 * gli altri (swallow), unsubscribe rimuove davvero.
 */
import { describe, it, expect, vi } from 'vitest';
import { emitCommunityNodesChanged, onCommunityNodesChanged } from './community-nodes-events.js';

describe('community-nodes-events — pub/sub', () => {
  it('emit chiama tutti i listener registrati', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onCommunityNodesChanged(a);
    const offB = onCommunityNodesChanged(b);
    emitCommunityNodesChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('un listener che LANCIA non impedisce agli altri di ricevere (swallow)', () => {
    const boom = vi.fn(() => {
      throw new Error('listener rotto');
    });
    const ok = vi.fn();
    const off1 = onCommunityNodesChanged(boom);
    const off2 = onCommunityNodesChanged(ok);
    expect(() => {
      emitCommunityNodesChanged();
    }).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1); // ricevuto nonostante boom
    off1();
    off2();
  });

  it('unsubscribe rimuove il listener (non più chiamato dopo off())', () => {
    const l = vi.fn();
    const off = onCommunityNodesChanged(l);
    off();
    emitCommunityNodesChanged();
    expect(l).not.toHaveBeenCalled();
  });

  it('doppio unsubscribe non lancia (idempotente)', () => {
    const off = onCommunityNodesChanged(vi.fn());
    off();
    expect(() => {
      off();
    }).not.toThrow();
  });
});
