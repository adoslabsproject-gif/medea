/**
 * GUARD CODEBASE-WIDE — integrità dei configField su TUTTI i nodi del catalog.
 *
 * Difetti reali che la UI/scaffold subiscono silenziosamente (NON NLP, deterministici):
 *  1. select con `defaultValue` NON tra le `options` → il drawer parte su un valore
 *     invalido / l'enum-validator lo rigetta.
 *  2. `showIf.field` che punta a una key INESISTENTE nel nodo → il campo non compare
 *     mai (o compare sempre) → feature irraggiungibile.
 *  3. select con `options` vuote → dropdown vuoto.
 *
 * Itera ogni nodo di ogni package (stdlib/db/integrations-core/italia/ai-agents/llm).
 * Considera anche i campi annidati in `actions[].configFields` e `resources[]` (pattern
 * Resource/Operation), perché lì vivono molti campi.
 */
import { describe, it, expect } from 'vitest';
import { stdlibNodes } from '@medea/engine-nodes-stdlib';
import { dbNodes } from '@medea/engine-nodes-db';
import { coreIntegrationNodes } from '@medea/engine-nodes-integrations-core';
import { italianConnectors } from '@medea/engine-nodes-integrations-italia';
import { aiAgentNodes } from '@medea/engine-nodes-ai-agents';
import { llmNodes } from '@medea/engine-nodes-llm';
import type { NodeModule } from '@medea/engine-nodes-stdlib';
import type { NodeDef } from '@medea/engine-core-schema';

const ALL_NODES: NodeModule[] = [
  ...stdlibNodes, ...dbNodes, ...coreIntegrationNodes,
  ...italianConnectors, ...aiAgentNodes, ...llmNodes,
];

type Field = NonNullable<NodeDef['configFields']>[number];

/** Tutti i gruppi di configField del nodo: top-level + per-action + per-resource. */
function fieldGroups(def: NodeDef): { scope: string; fields: readonly Field[] }[] {
  const groups: { scope: string; fields: readonly Field[] }[] = [];
  if (def.configFields) groups.push({ scope: 'top', fields: def.configFields });
  for (const a of def.actions ?? []) {
    if (a.configFields) groups.push({ scope: `action:${a.id ?? '?'}`, fields: a.configFields });
  }
  for (const r of def.resources ?? []) {
    if (r.configFields) groups.push({ scope: `resource:${r.id ?? '?'}`, fields: r.configFields });
  }
  return groups;
}

describe('GUARD codebase-wide — integrità configField', () => {
  it('catalog non vuoto (sanity)', () => {
    expect(ALL_NODES.length).toBeGreaterThan(50);
  });

  it('🚨 select: defaultValue (se presente) è una delle options', () => {
    const offenders: string[] = [];
    for (const n of ALL_NODES) {
      for (const g of fieldGroups(n.def)) {
        for (const f of g.fields) {
          if (f.type === 'select' && typeof f.defaultValue === 'string' && f.defaultValue !== '') {
            const opts = f.options ?? [];
            if (!opts.includes(f.defaultValue)) {
              offenders.push(`${n.def.id}/${g.scope}/${f.key}: default "${f.defaultValue}" ∉ [${opts.join(',')}]`);
            }
          }
        }
      }
    }
    expect(offenders, `default fuori da options:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('🚨 showIf.field punta a una key di configField esistente nel nodo', () => {
    const offenders: string[] = [];
    for (const n of ALL_NODES) {
      const groups = fieldGroups(n.def);
      // Le chiavi visibili a uno showIf: top-level + (per i campi di un'action) quelle dell'action.
      const topKeys = new Set((n.def.configFields ?? []).map((f) => f.key));
      for (const g of groups) {
        const localKeys = new Set([...topKeys, ...g.fields.map((f) => f.key)]);
        for (const f of g.fields) {
          const showIf = (f as { showIf?: { field?: string } }).showIf;
          if (showIf?.field && !localKeys.has(showIf.field)) {
            offenders.push(`${n.def.id}/${g.scope}/${f.key}: showIf.field "${showIf.field}" non esiste`);
          }
        }
      }
    }
    expect(offenders, `showIf.field rotto:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('🚨 select ha almeno una option', () => {
    const offenders: string[] = [];
    for (const n of ALL_NODES) {
      for (const g of fieldGroups(n.def)) {
        for (const f of g.fields) {
          if (f.type === 'select' && (f.options ?? []).length === 0) {
            offenders.push(`${n.def.id}/${g.scope}/${f.key}: select senza options`);
          }
        }
      }
    }
    expect(offenders, `select vuoti:\n${offenders.join('\n')}`).toEqual([]);
  });
});
