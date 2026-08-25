/**
 * Un filtro puntato su qualcosa che non è una lista.
 *
 * Il caso vero: «Email con parole chiave», 2026-08-16.
 *
 *     trigger_imap → action_filter → community_telegram
 *
 * L'utente voleva un avviso su Telegram per le email con «urgente» o
 * «scadenza». Il trigger produce UN messaggio, non un elenco: il filtro
 * avrebbe lavorato su zero elementi, non ne avrebbe fatto passare nessuno, e
 * Telegram avrebbe mandato l'avviso lo stesso — per OGNI email.
 *
 * Come per ogni regola sul senso del flusso, i casi che dimostrano quando deve
 * TACERE contano più di quello che la fa scattare.
 *
 * @module services/ai-scaffold/rule-lista-che-non-arriva.test
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { runQualityGate } from '@/services/ai-scaffold/quality-gate.js';
import {
  __test__,
  checkListaCheNonArriva,
} from '@/services/ai-scaffold/rule-lista-che-non-arriva.js';

beforeEach(() => {
  __test__.dimentica();
});

describe('il caso che è passato', () => {
  const emailConParoleChiave = {
    nodes: [
      { id: 'imap', defId: 'trigger_imap', config: {} },
      {
        id: 'filtra',
        defId: 'action_filter',
        config: {
          conditions: JSON.stringify({
            combinator: 'OR',
            rules: [{ field: 'subject', op: 'contains', value: 'urgente' }],
          }),
        },
      },
      { id: 'telegram', defId: 'community_telegram', config: { chatId: '1', text: 'x' } },
    ],
    edges: [
      { from: 'imap', to: 'filtra' },
      { from: 'filtra', to: 'telegram' },
    ],
  };

  it('lo prende', () => {
    const issues = checkListaCheNonArriva(emailConParoleChiave);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe('filtra');
    expect(issues[0]?.severity).toBe('critical');
  });

  /**
   * Il messaggio deve dire la conseguenza — l'avviso che scatta sempre — e la
   * strada giusta. Senza il rimedio, il modello rigenera lo stesso errore.
   */
  it('dice cosa succederebbe e cosa usare al posto', () => {
    const [issue] = checkListaCheNonArriva(emailConParoleChiave);
    expect(issue?.message).toContain('SEMPRE');
    expect(issue?.message).toContain('un solo elemento');
    expect(issue?.message).toContain('logic_if');
  });

  it('il gate completo lo boccia', () => {
    const esito = runQualityGate(emailConParoleChiave);
    expect(esito.issues.some((i) => i.code === 'LISTA_CHE_NON_ARRIVA')).toBe(true);
  });
});

describe('quando deve tacere', () => {
  /** Il caso normale: molte righe da una query, e un filtro che ne tiene alcune. */
  it('a monte c’è chi dichiara una lista', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'righe', defId: 'db_query', config: { table: 'ordini' } },
        { id: 'filtra', defId: 'action_filter', config: {} },
      ],
      edges: [{ from: 'righe', to: 'filtra' }],
    });
    expect(issues).toHaveLength(0);
  });

  /** Ha detto lui da dove prendere la lista: l'ingresso non c'entra. */
  it('il filtro ha una sorgente sua', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'imap', defId: 'trigger_imap', config: {} },
        {
          id: 'filtra',
          defId: 'action_filter',
          config: { items: '{{$node.imap.json.attachments}}' },
        },
      ],
      edges: [{ from: 'imap', to: 'filtra' }],
    });
    expect(issues).toHaveLength(0);
  });

  /**
   * `input` è il valore predefinito e vuol dire «quello che mi arriva»:
   * scriverlo non cambia niente, e non deve mettere a tacere il controllo.
   */
  it('«input» non conta come sorgente propria', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'imap', defId: 'trigger_imap', config: {} },
        {
          id: 'filtra',
          defId: 'action_filter',
          config: {
            items: 'input',
            conditions: JSON.stringify([{ field: 'subject', op: 'contains', value: 'urgente' }]),
          },
        },
      ],
      edges: [{ from: 'imap', to: 'filtra' }],
    });
    expect(issues).toHaveLength(1);
  });

  /**
   * `trigger_imap` dichiara `attachments: array`, e un tempo bastava quello a
   * zittire la regola: il caso vero passava. Filtrare GLI ALLEGATI di un
   * messaggio è invece legittimo, e si riconosce dal campo su cui si filtra.
   */
  it('filtrare gli allegati del messaggio è legittimo', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'imap', defId: 'trigger_imap', config: {} },
        {
          id: 'filtra',
          defId: 'action_filter',
          config: {
            items: '{{$node.imap.json.attachments}}',
            conditions: JSON.stringify([{ field: 'contentType', op: 'contains', value: 'pdf' }]),
          },
        },
      ],
      edges: [{ from: 'imap', to: 'filtra' }],
    });
    expect(issues).toHaveLength(0);
  });

  /** Le colonne di una tabella non sono i campi del nodo che le legge. */
  it('filtrare le righe di una query per una colonna', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'righe', defId: 'db_query', config: { table: 'ordini' } },
        {
          id: 'filtra',
          defId: 'action_filter',
          config: {
            conditions: JSON.stringify([{ field: 'totale', op: 'gt', value: 100 }]),
          },
        },
      ],
      edges: [{ from: 'righe', to: 'filtra' }],
    });
    expect(issues).toHaveLength(0);
  });

  it('un nodo senza contratto non fa indovinare', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'ignoto', defId: 'defId_che_non_esiste', config: {} },
        { id: 'filtra', defId: 'action_filter', config: {} },
      ],
      edges: [{ from: 'ignoto', to: 'filtra' }],
    });
    expect(issues).toHaveLength(0);
  });

  it('un filtro scollegato ha già il suo controllo', () => {
    const issues = checkListaCheNonArriva({
      nodes: [{ id: 'filtra', defId: 'action_filter', config: {} }],
      edges: [],
    });
    expect(issues).toHaveLength(0);
  });

  it('un nodo che non lavora su liste non la riguarda', () => {
    const issues = checkListaCheNonArriva({
      nodes: [
        { id: 'imap', defId: 'trigger_imap', config: {} },
        { id: 'se', defId: 'logic_if', config: { conditionRules: '{}' } },
      ],
      edges: [{ from: 'imap', to: 'se' }],
    });
    expect(issues).toHaveLength(0);
  });
});
