import { describe, it, expect } from 'vitest';
import { NodeDefSchema, ConfigFieldSchema } from './nodes.js';

describe('NodeDefSchema', () => {
  it('accepts a valid trigger node', () => {
    const node = {
      id: 'trigger_manual',
      type: 'trigger' as const,
      label: 'Manual',
      icon: 'play',
      color: '#4a90e2',
      description: 'Run the workflow manually.',
    };
    expect(NodeDefSchema.parse(node)).toEqual(node);
  });

  it('rejects invalid color format', () => {
    const result = NodeDefSchema.safeParse({
      id: 'foo',
      type: 'action',
      label: 'Foo',
      icon: 'icon',
      color: 'red',
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid node id (special chars)', () => {
    const result = NodeDefSchema.safeParse({
      id: 'foo bar!',
      type: 'action',
      label: 'Foo',
      icon: 'icon',
      color: '#ffffff',
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown category', () => {
    const result = NodeDefSchema.safeParse({
      id: 'foo',
      type: 'invalid',
      label: 'Foo',
      icon: 'icon',
      color: '#ffffff',
      description: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts node with config fields and outputs', () => {
    const node = {
      id: 'logic_if',
      type: 'logic' as const,
      label: 'If',
      icon: 'branch',
      color: '#a020f0',
      description: 'Branch on condition.',
      configFields: [
        { key: 'condition', label: 'Condition', type: 'text' as const, required: true },
      ],
      outputs: ['true', 'false'],
    };
    expect(NodeDefSchema.parse(node)).toEqual(node);
  });
});

describe('NodeDefSchema — community triggers (FEAT community-trigger runtime)', () => {
  const base = {
    id: 'acme_node',
    type: 'action' as const,
    label: 'Acme',
    icon: 'cube',
    color: '#3b82f6',
    description: 'Acme integration.',
  };

  it('un nodedef con triggers polling PARSA e i triggers SOPRAVVIVONO (non strippati)', () => {
    const node = {
      ...base,
      triggers: [
        { id: 'new_order', label: 'Nuovo ordine', mode: 'polling' as const, pollIntervalSec: 30 },
      ],
    };
    const parsed = NodeDefSchema.parse(node);
    // REGRESSIONE CRITICA: senza il campo nello schema, z.object strippa
    // `triggers` in silenzio → l'install perderebbe i trigger. Qui provo che
    // sopravvivono al parse.
    expect(parsed.triggers).toBeDefined();
    expect(parsed.triggers).toHaveLength(1);
    expect(parsed.triggers?.[0]).toMatchObject({ id: 'new_order', mode: 'polling', pollIntervalSec: 30 });
  });

  it('rifiuta un mode non valido', () => {
    const r = NodeDefSchema.safeParse({ ...base, triggers: [{ id: 'x', label: 'X', mode: 'webhook' }] });
    expect(r.success).toBe(false);
  });

  it('rifiuta un trigger id malformato', () => {
    const r = NodeDefSchema.safeParse({ ...base, triggers: [{ id: 'bad id!', label: 'X', mode: 'polling' }] });
    expect(r.success).toBe(false);
  });

  it('rifiuta pollIntervalSec non intero positivo', () => {
    const r = NodeDefSchema.safeParse({ ...base, triggers: [{ id: 'x', label: 'X', mode: 'polling', pollIntervalSec: -5 }] });
    expect(r.success).toBe(false);
  });

  it('nodedef SENZA triggers resta valido (campo opzionale, zero impatto legacy)', () => {
    expect(NodeDefSchema.parse(base).triggers).toBeUndefined();
  });
});

describe('ConfigFieldSchema', () => {
  it('accepts secret type for sensitive fields', () => {
    const field = {
      key: 'apiKey',
      label: 'API Key',
      type: 'secret' as const,
      required: true,
    };
    expect(ConfigFieldSchema.parse(field)).toEqual(field);
  });
});
