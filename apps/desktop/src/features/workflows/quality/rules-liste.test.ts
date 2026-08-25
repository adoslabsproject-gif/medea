/**
 * Un filtro puntato su qualcosa che non è una lista.
 *
 * Il caso vero: «Email con parole chiave», 2026-08-16 —
 * `trigger_imap → action_filter → community_telegram`. L'avviso su Telegram
 * sarebbe partito per ogni email, non solo per quelle urgenti.
 *
 * Come per ogni regola sul senso del flusso, i casi che dimostrano quando deve
 * TACERE contano più di quello che la fa scattare.
 *
 * @module features/workflows/quality/rules-liste.test
 */

import { describe, expect, it } from 'vitest';

import { checkListaCheNonArriva } from './rules-liste';
import type { QualityGateInput, QualityNodeDef } from './types';

const FILTRO: QualityNodeDef = {
  type: 'action',
  configFields: [
    { key: 'items', required: false },
    { key: 'conditions', required: true },
  ],
};

/** `trigger_imap`: un messaggio solo, con gli allegati dentro. */
const IMAP: QualityNodeDef = {
  type: 'trigger',
  outputContract: {
    fields: [
      { name: 'subject', type: 'string' },
      { name: 'from', type: 'string' },
      { name: 'attachments', type: 'array' },
    ],
  },
};

/** `db_query`: molte righe. */
const QUERY: QualityNodeDef = {
  type: 'action',
  outputContract: {
    fields: [
      { name: 'rows', type: 'array' },
      { name: 'rowCount', type: 'number' },
    ],
  },
};

const defs = new Map<string, QualityNodeDef>([
  ['action_filter', FILTRO],
  ['trigger_imap', IMAP],
  ['db_query', QUERY],
]);

function ingresso(configFiltro: Record<string, unknown>, monte = 'trigger_imap'): QualityGateInput {
  return {
    nodes: [
      { id: 'sorgente', defId: monte, config: {} },
      { id: 'filtra', defId: 'action_filter', config: configFiltro },
    ],
    edges: [{ from: 'sorgente', to: 'filtra' }],
    defs,
  };
}

const SU_OGGETTO = JSON.stringify([{ field: 'subject', op: 'contains', value: 'urgente' }]);

describe('il caso che è passato', () => {
  it('lo prende', () => {
    const issues = checkListaCheNonArriva(ingresso({ conditions: SU_OGGETTO }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe('filtra');
    expect(issues[0]?.severity).toBe('critical');
  });

  it('dice la conseguenza e il rimedio', () => {
    const [issue] = checkListaCheNonArriva(ingresso({ conditions: SU_OGGETTO }));
    expect(issue?.message).toContain('SEMPRE');
    expect(issue?.message).toContain('logic_if');
  });

  /** `input` è il valore predefinito: scriverlo non è dichiarare una sorgente. */
  it('«input» non conta come sorgente propria', () => {
    const issues = checkListaCheNonArriva(ingresso({ items: 'input', conditions: SU_OGGETTO }));
    expect(issues).toHaveLength(1);
  });
});

describe('quando deve tacere', () => {
  it('filtrare le righe di una query per una colonna', () => {
    const issues = checkListaCheNonArriva(
      ingresso(
        { conditions: JSON.stringify([{ field: 'totale', op: 'gt', value: 100 }]) },
        'db_query',
      ),
    );
    expect(issues).toHaveLength(0);
  });

  /** Gli allegati di un messaggio sono un elenco vero. */
  it('filtrare gli allegati è legittimo', () => {
    const issues = checkListaCheNonArriva(
      ingresso({
        items: '{{$node.sorgente.json.attachments}}',
        conditions: JSON.stringify([{ field: 'contentType', op: 'contains', value: 'pdf' }]),
      }),
    );
    expect(issues).toHaveLength(0);
  });

  it('senza contratto a monte non si indovina', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'sorgente', defId: 'ignoto', config: {} },
        { id: 'filtra', defId: 'action_filter', config: { conditions: SU_OGGETTO } },
      ],
      edges: [{ from: 'sorgente', to: 'filtra' }],
      defs: new Map([
        ['action_filter', FILTRO],
        ['ignoto', { type: 'action' }],
      ]),
    });
    expect(issues).toHaveLength(0);
  });

  it('senza le definizioni la regola non gira', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'sorgente', defId: 'trigger_imap', config: {} },
        { id: 'filtra', defId: 'action_filter', config: { conditions: SU_OGGETTO } },
      ],
      edges: [{ from: 'sorgente', to: 'filtra' }],
    });
    expect(issues).toHaveLength(0);
  });

  it('un filtro scollegato ha già il suo controllo', () => {
    const issues = checkListaCheNonArriva({
      nodes: [{ id: 'filtra', defId: 'action_filter', config: { conditions: SU_OGGETTO } }],
      edges: [],
      defs,
    });
    expect(issues).toHaveLength(0);
  });
});
