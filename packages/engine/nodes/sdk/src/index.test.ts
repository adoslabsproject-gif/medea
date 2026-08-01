import { describe, it, expect } from 'vitest';
import { defineNode, defineNodes, NodeManifestSchema } from './index.js';

describe('defineNode', () => {
  it('separates def from executor and validates the def', () => {
    const node = defineNode({
      id: 'action_demo',
      type: 'action',
      label: 'Demo',
      icon: 'box',
      color: '#123456',
      description: 'demo',
      execute: async () => ({ output: 'ok', durationMs: 1 }),
    });
    expect(node.def.id).toBe('action_demo');
    expect(typeof node.executor).toBe('function');
    expect('execute' in node.def).toBe(false);
  });

  it('rejects invalid NodeDef shape', () => {
    expect(() =>
      defineNode({
        id: 'invalid id!',
        type: 'action',
        label: 'X',
        icon: 'x',
        color: 'red',
        description: '',
      }),
    ).toThrow();
  });
});

describe('NodeManifestSchema', () => {
  it('validates a well-formed manifest', () => {
    const ok = NodeManifestSchema.safeParse({
      name: '@acme/flowforge-stripe',
      version: '1.2.3',
      author: { name: 'Acme', email: 'dev@acme.com' },
      license: 'MIT',
      flowforgeApiVersion: '1.0',
      nodes: ['action_stripe_charge', 'action_stripe_refund'],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects non-semver version', () => {
    const bad = NodeManifestSchema.safeParse({
      name: '@a/b',
      version: 'v1',
      author: { name: 'x' },
      flowforgeApiVersion: '1.0',
      nodes: [],
    });
    expect(bad.success).toBe(false);
  });
});

describe('defineNodes', () => {
  it('processes multiple node definitions', () => {
    const nodes = defineNodes(
      { id: 'action_a', type: 'action', label: 'A', icon: 'a', color: '#000000', description: 'a' },
      { id: 'action_b', type: 'action', label: 'B', icon: 'b', color: '#ffffff', description: 'b' },
    );
    expect(nodes).toHaveLength(2);
  });
});
