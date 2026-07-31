/**
 * Il formato del catalogo è un contratto col modello fine-tuned: le righe
 * devono restare byte-per-byte in questa forma (vedi ADR 0005 e il commento
 * in `catalog.ts`). Questi test bloccano ogni deriva involontaria.
 */

import { describe, expect, it } from 'vitest';

import type { NodeDef } from '../types';

import {
  formatCatalog,
  formatCatalogEntry,
  FULL_CATALOG_THRESHOLD,
  indexByDefId,
  selectCatalog,
} from './catalog';
import { at, CATALOG } from './fixtures';

describe('formatCatalogEntry — contratto di formato', () => {
  it('mantiene la forma compatta attesa dal modello', () => {
    expect(formatCatalogEntry(at(CATALOG, 1))).toBe(
      'action_http (action): url:string(REQUIRED), method:select(enum[GET|POST|PUT|DELETE],default="GET")',
    );
  });

  it('rende pattern e vincoli inline', () => {
    const def: NodeDef = {
      defId: 'x',
      type: 'action',
      label: 'X',
      configFields: [{ key: 'code', type: 'string', required: true, pattern: '^[A-Z]+$' }],
    };
    expect(formatCatalogEntry(def)).toBe('x (action): code:string(REQUIRED,regex:^[A-Z]+$)');
  });

  it('segnala i nodi senza configurazione invece di lasciare il vuoto', () => {
    expect(formatCatalogEntry({ defId: 'x', type: 'action', label: 'X' })).toBe(
      'x (action): (no config)',
    );
  });

  it('elenca le azioni e tronca oltre le 30 con ellissi', () => {
    const actions = Array.from({ length: 31 }, (_, i) => ({ id: `az_${i}` }));
    const line = formatCatalogEntry({ defId: 'n', type: 'action', label: 'N', actions });
    expect(line).toContain('actions[az_0,');
    expect(line).toContain('az_29,…]');
    expect(line).not.toContain('az_30,');
  });

  it('formatCatalog produce una riga per nodo', () => {
    expect(formatCatalog(CATALOG).split('\n')).toHaveLength(CATALOG.length);
  });
});

function bigCatalog(extra: NodeDef[]): NodeDef[] {
  const filler: NodeDef[] = Array.from({ length: FULL_CATALOG_THRESHOLD + 1 }, (_, i) => ({
    defId: `filler_${i}`,
    type: 'action',
    label: `Riempitivo ${i}`,
  }));
  return [...CATALOG, ...extra, ...filler];
}

describe('selectCatalog — recupero lessicale', () => {
  it('sotto la soglia restituisce il catalogo intero', () => {
    expect(selectCatalog(CATALOG, 'qualsiasi cosa', ['trigger_cron'])).toEqual(CATALOG);
  });

  it('sopra la soglia i nodi core ci sono sempre, anche fuori tema', () => {
    const defs = bigCatalog([]);
    const picked = selectCatalog(defs, 'argomento del tutto estraneo zzz', ['trigger_cron']);
    expect(picked.map((d) => d.defId)).toContain('trigger_cron');
    expect(picked.length).toBeLessThan(defs.length);
  });

  it('recupera i nodi pertinenti alla richiesta tramite alias', () => {
    const slack: NodeDef = {
      defId: 'action_slack',
      type: 'action',
      label: 'Slack',
      searchAliases: ['slack', 'chat aziendale'],
    };
    const picked = selectCatalog(bigCatalog([slack]), 'manda un messaggio su slack', [
      'trigger_cron',
    ]);
    expect(picked.map((d) => d.defId)).toContain('action_slack');
  });

  it('è insensibile agli accenti: "però" trova "pero"', () => {
    const def: NodeDef = { defId: 'action_pero', type: 'action', label: 'pero frutteto' };
    const picked = selectCatalog(bigCatalog([def]), 'gestisci il però', ['trigger_cron']);
    expect(picked.map((d) => d.defId)).toContain('action_pero');
  });

  it('rispetta il limite anche con molti nodi pertinenti', () => {
    const many: NodeDef[] = Array.from({ length: 60 }, (_, i) => ({
      defId: `report_${i}`,
      type: 'action',
      label: `report vendite ${i}`,
    }));
    const picked = selectCatalog(bigCatalog(many), 'report vendite', ['trigger_cron'], 10);
    expect(picked.length).toBeLessThanOrEqual(10);
    expect(picked.map((d) => d.defId)).toContain('trigger_cron');
  });

  it('ignora le parole sotto i 3 caratteri: niente falsi match', () => {
    const def: NodeDef = { defId: 'action_ab', type: 'action', label: 'ab cd ef' };
    const picked = selectCatalog(bigCatalog([def]), 'il ab di ef', ['trigger_cron']);
    expect(picked.map((d) => d.defId)).not.toContain('action_ab');
  });
});

describe('indexByDefId', () => {
  it('indicizza ogni definizione per defId', () => {
    const index = indexByDefId(CATALOG);
    expect(index.size).toBe(CATALOG.length);
    expect(index.get('action_http')?.label).toBe('Chiamata HTTP');
  });

  it('con defId duplicati vince l’ultimo: comportamento deterministico', () => {
    const index = indexByDefId([
      { defId: 'x', type: 'action', label: 'primo' },
      { defId: 'x', type: 'action', label: 'secondo' },
    ]);
    expect(index.get('x')?.label).toBe('secondo');
  });
});
