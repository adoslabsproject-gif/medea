/**
 * Quello che arriva dal motore è dato altrui: qui si controlla che venga
 * guardato prima di essere creduto, e che la traduzione non perda pezzi per
 * strada senza dirlo.
 */

import { describe, expect, it } from 'vitest';

import type { ProviderId } from '../../ai/types';

import { providerPerMotore, tabelleDalMotore, workflowDalMotore } from './motore-mappa';

const WORKFLOW_VALIDO = {
  name: 'Archivia le newsletter',
  description: 'Sposta le newsletter in una cartella.',
  nodes: [
    { id: 'quando_arriva', defId: 'trigger_imap', x: 0, y: 0, config: { folder: 'INBOX' } },
    { id: 'archivia', defId: 'action_email_clean', x: 200, y: 0, config: {} },
  ],
  edges: [{ from: 'quando_arriva', to: 'archivia' }],
};

describe('providerPerMotore', () => {
  it('traduce i provider che il motore conosce', () => {
    expect(providerPerMotore('liara')).toBe('liara');
    expect(providerPerMotore('anthropic')).toBe('anthropic');
    expect(providerPerMotore('openai')).toBe('openai');
    expect(providerPerMotore('gemini')).toBe('gemini');
    expect(providerPerMotore('deepseek')).toBe('deepseek');
    expect(providerPerMotore('grok')).toBe('grok');
    expect(providerPerMotore('openrouter')).toBe('openrouter');
  });

  /**
   * I due che non passano, e il perché va tenuto scritto: `custom` vive nel suo
   * indirizzo e la richiesta al motore non ha un campo dove metterlo;
   * `claude-cli` è l'abbonamento e non ha una chiave da passare a nessuno.
   *
   * Non è un errore, è il ripiego alla strada locale: se un giorno qualcuno li
   * facesse tornare una stringa qualsiasi, il motore riceverebbe un provider
   * che non sa servire e il wizard fallirebbe invece di ripiegare.
   */
  it('non traduce quelli che il motore non sa servire', () => {
    expect(providerPerMotore('custom')).toBeNull();
    expect(providerPerMotore('claude-cli')).toBeNull();
  });

  it('ha una risposta per ogni provider esistente', () => {
    const tutti: ProviderId[] = [
      'liara',
      'claude-cli',
      'custom',
      'anthropic',
      'openai',
      'gemini',
      'deepseek',
      'grok',
      'openrouter',
    ];
    for (const p of tutti) {
      expect(providerPerMotore(p)).not.toBeUndefined();
    }
  });
});

describe('workflowDalMotore', () => {
  it('traduce un workflow completo', () => {
    const w = workflowDalMotore(WORKFLOW_VALIDO);
    expect(w?.name).toBe('Archivia le newsletter');
    expect(w?.description).toBe('Sposta le newsletter in una cartella.');
    expect(w?.nodes).toHaveLength(2);
    expect(w?.nodes[0]?.defId).toBe('trigger_imap');
    expect(w?.nodes[0]?.config).toEqual({ folder: 'INBOX' });
    expect(w?.edges).toEqual([{ from: 'quando_arriva', to: 'archivia' }]);
    expect(w?.executionTarget).toBe('local');
  });

  it('tiene il ramo di uscita quando c’è: senza, un `logic_if` perde una strada', () => {
    const w = workflowDalMotore({
      ...WORKFLOW_VALIDO,
      edges: [{ from: 'a', to: 'b', fromPort: 'true' }],
    });
    expect(w?.edges[0]?.fromPort).toBe('true');
  });

  /**
   * Un nodo rotto fa cadere tutto, non viene saltato.
   *
   * Saltarlo darebbe un workflow che si apre, sembra completo, e ha un buco
   * dove doveva esserci un passaggio: nessuno può accorgersene guardandolo,
   * perché il pezzo mancante non lascia traccia. Un fallimento dichiarato si
   * vede; una consegna incompleta no.
   */
  it('rifiuta tutto se un nodo è senza defId', () => {
    const rotto = {
      ...WORKFLOW_VALIDO,
      nodes: [WORKFLOW_VALIDO.nodes[0], { id: 'senza_def', x: 0, y: 0, config: {} }],
    };
    expect(workflowDalMotore(rotto)).toBeNull();
  });

  it('rifiuta tutto se un collegamento è monco', () => {
    const rotto = { ...WORKFLOW_VALIDO, edges: [{ from: 'quando_arriva' }] };
    expect(workflowDalMotore(rotto)).toBeNull();
  });

  it('rifiuta ciò che workflow non è', () => {
    expect(workflowDalMotore(null)).toBeNull();
    expect(workflowDalMotore('un discorso')).toBeNull();
    expect(workflowDalMotore({ nodes: [], edges: [] })).toBeNull();
    expect(workflowDalMotore({ name: 'x', nodes: [] })).toBeNull();
  });

  /** Coordinate assenti valgono zero: il disegno le rifà comunque. */
  it('sopporta i nodi senza coordinate', () => {
    const w = workflowDalMotore({
      name: 'x',
      nodes: [{ id: 'a', defId: 'trigger_manual', config: {} }],
      edges: [],
    });
    expect(w?.nodes[0]?.x).toBe(0);
    expect(w?.nodes[0]?.y).toBe(0);
  });
});

describe('tabelleDalMotore', () => {
  it('tiene le tabelle complete', () => {
    const t = tabelleDalMotore([
      { name: 'newsletter', columns: [{ name: 'mittente', type: 'text', nullable: true }] },
    ]);
    expect(t).toEqual([
      { name: 'newsletter', columns: [{ name: 'mittente', type: 'text', nullable: true }] },
    ]);
  });

  it('scarta le tabelle senza colonne: prometterebbero una creazione che non avviene', () => {
    expect(tabelleDalMotore([{ name: 'vuota', columns: [] }])).toBeUndefined();
    expect(tabelleDalMotore([{ name: 'vuota', columns: [{ type: 'text' }] }])).toBeUndefined();
  });

  it('tace su ciò che tabella non è', () => {
    expect(tabelleDalMotore(undefined)).toBeUndefined();
    expect(tabelleDalMotore('niente')).toBeUndefined();
  });
});
