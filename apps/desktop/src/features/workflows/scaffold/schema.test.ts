/**
 * Due contratti in un modulo. Lo schema JSON è condiviso col server: i suoi
 * vincoli numerici e i pattern sono parità di protocollo, non dettagli.
 * `isScaffoldOutput` è la porta d'ingresso della pipeline: tutto ciò che
 * passa di qui viene toccato da riparazione e validazione senza try/catch
 * interni, quindi ogni forma patologica DEVE essere respinta alla porta.
 */

import { describe, expect, it } from 'vitest';

import { makeValid } from './fixtures';
import { isScaffoldOutput, SINGLESHOT_OUTPUT_SCHEMA, TABLE_COLUMN_TYPES } from './schema';

describe('SINGLESHOT_OUTPUT_SCHEMA — parità col server', () => {
  it('i campi obbligatori sono esattamente name, reasoning, nodes, edges', () => {
    expect(SINGLESHOT_OUTPUT_SCHEMA.required).toEqual(['name', 'reasoning', 'nodes', 'edges']);
  });

  it('gli id dei nodi sono snake_case minuscolo', () => {
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.nodes.items.properties.id.pattern).toBe(
      '^[a-z][a-z0-9_]*$',
    );
  });

  it('i limiti dimensionali non derivano in silenzio', () => {
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.nodes.minItems).toBe(3);
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.nodes.maxItems).toBe(30);
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.edges.maxItems).toBe(60);
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.tablesToCreate.maxItems).toBe(5);
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.reasoning.minLength).toBe(60);
  });

  it('vieta proprietà sconosciute a ogni livello', () => {
    expect(SINGLESHOT_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.nodes.items.additionalProperties).toBe(false);
    expect(SINGLESHOT_OUTPUT_SCHEMA.properties.edges.items.additionalProperties).toBe(false);
  });

  it('i tipi colonna dello schema sono la stessa lista usata dalla validazione', () => {
    const enumTypes =
      SINGLESHOT_OUTPUT_SCHEMA.properties.tablesToCreate.items.properties.columns.items.properties
        .type.enum;
    expect(enumTypes).toBe(TABLE_COLUMN_TYPES);
    expect(TABLE_COLUMN_TYPES).toEqual(['text', 'integer', 'real', 'boolean', 'timestamp', 'json']);
  });
});

describe('isScaffoldOutput — la porta respinge le forme patologiche', () => {
  it('accetta l’output valido di riferimento', () => {
    expect(isScaffoldOutput(makeValid())).toBe(true);
  });

  it('accetta tablesToCreate ben formato o assente', () => {
    const out = makeValid();
    expect(isScaffoldOutput(out)).toBe(true);
    out.tablesToCreate = [{ name: 'followups', columns: [{ name: 'id', type: 'integer' }] }];
    expect(isScaffoldOutput(out)).toBe(true);
  });

  it.each([
    ['null', null],
    ['stringa', 'workflow'],
    ['array in radice', [1, 2]],
    ['numero', 42],
  ])('respinge %s', (_label, value) => {
    expect(isScaffoldOutput(value)).toBe(false);
  });

  it('respinge un output senza nodes o edges array', () => {
    expect(isScaffoldOutput({ name: 'x', reasoning: 'y', nodes: {}, edges: [] })).toBe(false);
    expect(isScaffoldOutput({ name: 'x', reasoning: 'y', nodes: [], edges: 'no' })).toBe(false);
  });

  it('respinge un nodo senza config: farebbe esplodere la riparazione', () => {
    const out: unknown = {
      name: 'x',
      reasoning: 'y',
      nodes: [{ id: 'a', defId: 'trigger_cron' }],
      edges: [],
    };
    expect(isScaffoldOutput(out)).toBe(false);
  });

  it('respinge config null, array o stringa', () => {
    for (const config of [null, [], 'GET']) {
      const out: unknown = {
        name: 'x',
        reasoning: 'y',
        nodes: [{ id: 'a', defId: 'trigger_cron', config }],
        edges: [],
      };
      expect(isScaffoldOutput(out)).toBe(false);
    }
  });

  it('respinge nodi con id o defId non-stringa', () => {
    const out: unknown = {
      name: 'x',
      reasoning: 'y',
      nodes: [{ id: 7, defId: 'trigger_cron', config: {} }],
      edges: [],
    };
    expect(isScaffoldOutput(out)).toBe(false);
  });

  it('respinge un nodo null in mezzo alla lista', () => {
    const out = makeValid() as unknown as { nodes: unknown[] };
    out.nodes.push(null);
    expect(isScaffoldOutput(out)).toBe(false);
  });

  it('respinge collegamenti senza from/to stringa', () => {
    const base = makeValid() as unknown as { edges: unknown[] };
    base.edges.push({ from: 'cron' });
    expect(isScaffoldOutput(base)).toBe(false);
  });

  it('respinge tablesToCreate malformato', () => {
    const out = makeValid() as unknown as Record<string, unknown>;
    out.tablesToCreate = 'followups';
    expect(isScaffoldOutput(out)).toBe(false);
    out.tablesToCreate = [{ name: 'followups' }];
    expect(isScaffoldOutput(out)).toBe(false);
    out.tablesToCreate = [{ name: 'followups', columns: [{ name: 'id', type: 7 }] }];
    expect(isScaffoldOutput(out)).toBe(false);
  });
});
