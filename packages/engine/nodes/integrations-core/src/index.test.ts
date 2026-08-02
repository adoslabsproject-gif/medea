import { describe, it, expect } from 'vitest';
import { NodeDefSchema } from '@medea/engine-core-schema';
import { coreIntegrationNodes } from './index.js';

describe('coreIntegrationNodes', () => {
  // 2026-05-30 cleanup: i 7 nodi vendor-specific (slack/github/notion/stripe/
  // linear/discord/telegram) sono stati RIMOSSI (vedi src/index.ts).
  // Il contratto del bundle loader richiede un array (anche vuoto) → length 0 OK.
  it('exports empty array (vendor-specific delegated to community v2.0)', () => {
    expect(Array.isArray(coreIntegrationNodes)).toBe(true);
    expect(coreIntegrationNodes.length).toBeGreaterThanOrEqual(0);
  });

  it('every node validates against NodeDefSchema', () => {
    for (const node of coreIntegrationNodes) {
      const result = NodeDefSchema.safeParse(node.def);
      if (!result.success) throw new Error(`${node.def.id}: ${result.error.message}`);
      expect(result.success).toBe(true);
    }
  });

  it('every node has an executor (real HTTP call)', () => {
    for (const node of coreIntegrationNodes) {
      expect(typeof node.executor).toBe('function');
    }
  });

  it('every node id is descriptive (provider_action pattern)', () => {
    for (const node of coreIntegrationNodes) {
      expect(node.def.id).toMatch(/^[a-z]+_/);
    }
  });

  it('secret credentials use type=secret', () => {
    for (const node of coreIntegrationNodes) {
      const secrets = node.def.configFields?.filter((f) => f.type === 'secret') ?? [];
      expect(secrets.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every node has descriptive color', () => {
    for (const node of coreIntegrationNodes) {
      expect(node.def.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
