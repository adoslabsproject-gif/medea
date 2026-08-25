/**
 * Un campo nudo dentro le graffe, visto dal motore.
 *
 * Il caso vero: «riassunto_serale», 2026-08-06. `{{tldr}}` nel testo di un
 * messaggio, `{{firedAt}}` in una riga di database. Nomi giusti, prefisso
 * mancante, valore vuoto a runtime e nessun errore da nessuna parte.
 *
 * Il gate del desktop lo mostra all'utente; questo lo fa RIFIUTARE dal motore,
 * che rigenera. È la differenza fra segnalare un difetto e non produrlo.
 *
 * @module services/ai-scaffold/rule-espressione-nuda.test
 */

import { describe, expect, it } from 'vitest';

import { checkEspressioneNuda } from '@/services/ai-scaffold/rule-espressione-nuda.js';
import { runQualityGate } from '@/services/ai-scaffold/quality-gate.js';

/** Il workflow com'era davvero, ridotto ai nodi che contano. */
const riassuntoSerale = {
  nodes: [
    {
      id: 'trigger_cron',
      defId: 'trigger_cron',
      config: { cronExpression: '0 18 * * *', timezone: 'Europe/Rome' },
    },
    { id: 'agent_summarizer', defId: 'agent_summarizer', config: { provider: 'liara' } },
    {
      id: 'community_slack',
      defId: 'community_slack',
      config: { channel: 'general', text: 'Riassunto di oggi:\n{{tldr}}' },
    },
    {
      id: 'db_insert',
      defId: 'db_insert',
      config: { table: 'riassunti', rowJson: '{"date":"{{firedAt}}","tldr":"{{tldr}}"}' },
    },
  ],
  edges: [
    { from: 'trigger_cron', to: 'agent_summarizer' },
    { from: 'agent_summarizer', to: 'community_slack' },
    { from: 'agent_summarizer', to: 'db_insert' },
  ],
};

describe('il caso che è passato', () => {
  it('adesso lo prende, e dice da quale nodo arriva il campo', () => {
    const issues = checkEspressioneNuda(riassuntoSerale);
    const messaggi = issues.map((i) => i.message).join('\n');

    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.every((i) => i.severity === 'critical')).toBe(true);
    expect(messaggi).toContain('{{$node.agent_summarizer.json.tldr}}');
    expect(messaggi).toContain('{{$node.trigger_cron.json.firedAt}}');
  });

  /**
   * Il punto di tutto: il gate deve RIFIUTARE, così il ciclo di rigenerazione
   * rimanda l'errore al modello invece di consegnare il workflow rotto.
   */
  it('il gate lo rifiuta invece di lasciarlo passare', () => {
    const esito = runQualityGate(riassuntoSerale);
    expect(esito.ok).toBe(false);
    expect(esito.shouldReject).toBe(true);
    expect(esito.issues.some((i) => i.code === 'ESPRESSIONE_NON_RISOLVIBILE')).toBe(true);
  });

  it('scritto per esteso non protesta più', () => {
    const corretto = {
      ...riassuntoSerale,
      nodes: riassuntoSerale.nodes.map((n) =>
        n.id === 'community_slack'
          ? { ...n, config: { ...n.config, text: '{{$node.agent_summarizer.json.tldr}}' } }
          : n.id === 'db_insert'
            ? {
                ...n,
                config: {
                  ...n.config,
                  rowJson:
                    '{"date":"{{$node.trigger_cron.json.firedAt}}",' +
                    '"tldr":"{{$node.agent_summarizer.json.tldr}}"}',
                },
              }
            : n,
      ),
    };
    expect(checkEspressioneNuda(corretto)).toEqual([]);
  });
});

describe('quello che deve restare fuori', () => {
  const base = (config: Record<string, unknown>) => ({
    nodes: [
      { id: 'cron', defId: 'trigger_cron', config: {} },
      { id: 'slack', defId: 'community_slack', config },
    ],
    edges: [{ from: 'cron', to: 'slack' }],
  });

  it('non tocca le radici dello scope', () => {
    for (const radice of ['input', 'secrets', 'vars', 'loop', 'item', 'index', 'output', 'ctx']) {
      expect(checkEspressioneNuda(base({ text: `{{${radice}}}` }))).toEqual([]);
    }
  });

  it('non tocca una parola che nessuno a monte produce', () => {
    expect(checkEspressioneNuda(base({ text: '{{pippo}}' }))).toEqual([]);
  });

  it('non tocca funzioni né espressioni composte', () => {
    expect(checkEspressioneNuda(base({ text: '{{ now() }}' }))).toEqual([]);
    expect(checkEspressioneNuda(base({ text: '{{ firedAt + 1 }}' }))).toEqual([]);
  });

  /**
   * Il campo esiste ma su un nodo a VALLE: non sapremmo cosa suggerire, e una
   * correzione sbagliata è peggio del silenzio.
   */
  it('non propone un nodo che sta a valle', () => {
    const alContrario = {
      nodes: [
        { id: 'slack', defId: 'community_slack', config: { text: '{{firedAt}}' } },
        { id: 'cron', defId: 'trigger_cron', config: {} },
      ],
      edges: [{ from: 'slack', to: 'cron' }],
    };
    expect(checkEspressioneNuda(alContrario)).toEqual([]);
  });

  /** Le espressioni annidate in un JSON di configurazione vanno guardate. */
  it('guarda anche dentro le strutture annidate', () => {
    const annidato = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'x', defId: 'community_slack', config: { blocks: [{ testo: '{{firedAt}}' }] } },
      ],
      edges: [{ from: 'cron', to: 'x' }],
    };
    expect(checkEspressioneNuda(annidato)).toHaveLength(1);
  });
});
