/**
 * Un nodo che elabora un contenuto che non gli arriva mai.
 *
 * Il caso vero: «riassunto_serale», 2026-08-06. `trigger_cron →
 * agent_summarizer`, e nessun nodo che leggesse la posta. Il riassuntore
 * avrebbe riassunto l'orario in cui è scattato, senza errori, e il testo
 * sarebbe partito via email.
 *
 * I test sotto contano più della regola: una regola sul SENSO del flusso
 * sbagliata blocca lavoro legittimo, e qui la metà dei casi serve a dimostrare
 * quando deve TACERE.
 *
 * @module services/ai-scaffold/rule-niente-da-elaborare.test
 */

import { describe, expect, it } from 'vitest';

import { runQualityGate } from '@/services/ai-scaffold/quality-gate.js';
import { checkNienteDaElaborare } from '@/services/ai-scaffold/rule-niente-da-elaborare.js';

describe('il caso che è passato', () => {
  const riassuntoSerale = {
    nodes: [
      { id: 'cron', defId: 'trigger_cron', config: { cronExpression: '0 18 * * *' } },
      { id: 'riassunto', defId: 'agent_summarizer', config: { provider: 'liara' } },
      { id: 'slack', defId: 'community_slack', config: { channel: 'x', text: 'y' } },
    ],
    edges: [
      { from: 'cron', to: 'riassunto' },
      { from: 'riassunto', to: 'slack' },
    ],
  };

  it('lo prende, e dice cosa manca', () => {
    const issues = checkNienteDaElaborare(riassuntoSerale);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe('riassunto');
    expect(issues[0]?.severity).toBe('critical');
    // Il messaggio deve dire che manca la SORGENTE, non dare un consiglio
    // generico: chi legge non sa a memoria quali tabelle ha.
    expect(issues[0]?.message).toContain('DOVE stanno');
  });

  it('il gate lo rifiuta, così il modello rigenera', () => {
    const esito = runQualityGate(riassuntoSerale);
    expect(esito.ok).toBe(false);
    expect(esito.issues.some((i) => i.code === 'NIENTE_DA_ELABORARE')).toBe(true);
  });

  /** Il modo giusto di scriverlo: qualcuno procura il contenuto. */
  it('con un nodo che procura il contenuto tace', () => {
    const corretto = {
      nodes: [
        ...riassuntoSerale.nodes,
        { id: 'posta', defId: 'trigger_imap', config: {} },
      ],
      edges: [
        { from: 'cron', to: 'posta' },
        { from: 'posta', to: 'riassunto' },
        { from: 'riassunto', to: 'slack' },
      ],
    };
    expect(checkNienteDaElaborare(corretto)).toEqual([]);
  });
});

/**
 * Il caso del 2026-08-07: `cron → action_filter → email`, e nessun nodo che
 * procurasse gli articoli. Il filtro avrebbe filtrato l'orario in cui è
 * scattato il cron, e l'email sarebbe partita vuota.
 */
describe('il messaggio nomina quello che l’utente ha davvero', () => {
  /**
   * «Metti il nodo che procura il contenuto» non si può seguire senza sapere
   * da dove. Elencare le tabelle che esistono trasforma un rimprovero in una
   * domanda a cui si può rispondere.
   */
  it('elenca le tabelle esistenti', () => {
    const issues = checkNienteDaElaborare({
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'filtra', defId: 'action_filter', config: {} },
      ],
      edges: [{ from: 'cron', to: 'filtra' }],
      databases: [{ id: 'db1', tables: ['inbox', 'ordini'] }],
    });
    expect(issues[0]?.message).toContain('«inbox»');
    expect(issues[0]?.message).toContain('«ordini»');
  });

  it('senza tabelle lo dice, invece di elencare il vuoto', () => {
    const issues = checkNienteDaElaborare({
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'filtra', defId: 'action_filter', config: {} },
      ],
      edges: [{ from: 'cron', to: 'filtra' }],
      databases: [],
    });
    expect(issues[0]?.message).toContain('nessuna tabella');
  });
});

describe('un trasformatore senza niente da trasformare', () => {
  it('lo prende quando la sorgente non è dichiarata', () => {
    const issues = checkNienteDaElaborare({
      nodes: [
        { id: 'ogni_mattina', defId: 'trigger_cron', config: {} },
        { id: 'filtra', defId: 'action_filter', config: { conditions: '[]' } },
      ],
      edges: [{ from: 'ogni_mattina', to: 'filtra' }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.nodeId).toBe('filtra');
  });

  /** Se il nodo dice DA DOVE prendere la lista, non aspetta l'ingresso. */
  it('tace se la sorgente è dichiarata nel nodo', () => {
    const issues = checkNienteDaElaborare({
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        {
          id: 'filtra',
          defId: 'action_filter',
          config: { items: '{{$node.query.json.rows}}', conditions: '[]' },
        },
      ],
      edges: [{ from: 'cron', to: 'filtra' }],
    });
    expect(issues).toEqual([]);
  });

  it('tace se qualcuno a monte procura la lista', () => {
    const issues = checkNienteDaElaborare({
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'leggi', defId: 'db_query', config: { table: 'articoli' } },
        { id: 'filtra', defId: 'action_filter', config: { conditions: '[]' } },
      ],
      edges: [
        { from: 'cron', to: 'leggi' },
        { from: 'leggi', to: 'filtra' },
      ],
    });
    expect(issues).toEqual([]);
  });
});

describe('quello che deve restare fuori', () => {
  /** «Alle 18 scarica la pagina e riassumila»: il contenuto c'è. */
  it('non tocca cron → scarica → riassumi', () => {
    const input = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'scarica', defId: 'action_fetch_url', config: { url: 'https://x.it' } },
        { id: 'riassunto', defId: 'agent_summarizer', config: {} },
      ],
      edges: [
        { from: 'cron', to: 'scarica' },
        { from: 'scarica', to: 'riassunto' },
      ],
    };
    expect(checkNienteDaElaborare(input)).toEqual([]);
  });

  /**
   * Un nodo che si porta dietro la propria materia non aspetta niente:
   * «alle 18 chiedi al modello di scrivere la frase del giorno» è legittimo.
   */
  it('non tocca un nodo che ha il proprio prompt', () => {
    const input = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'llm', defId: 'ai_openai', config: { apiKey: 'k', prompt: 'Scrivi una frase.' } },
      ],
      edges: [{ from: 'cron', to: 'llm' }],
    };
    expect(checkNienteDaElaborare(input)).toEqual([]);
  });

  /** Stessa cosa per un agente che persegue un obiettivo suo. */
  it('non tocca un agente con un obiettivo proprio', () => {
    const input = {
      nodes: [
        { id: 'cron', defId: 'trigger_cron', config: {} },
        { id: 'agente', defId: 'ai_agent_tool_loop', config: { goal: 'Controlla i prezzi.' } },
      ],
      edges: [{ from: 'cron', to: 'agente' }],
    };
    expect(checkNienteDaElaborare(input)).toEqual([]);
  });

  /**
   * Avviato a mano si può incollare il testo nella finestra di avvio: quel
   * payload è contenuto vero, e bloccarlo sarebbe togliere un modo di lavorare.
   */
  it('non tocca l’avvio manuale', () => {
    const input = {
      nodes: [
        { id: 'start', defId: 'trigger_manual', config: {} },
        { id: 'riassunto', defId: 'agent_summarizer', config: {} },
      ],
      edges: [{ from: 'start', to: 'riassunto' }],
    };
    expect(checkNienteDaElaborare(input)).toEqual([]);
  });

  it('non tocca un trigger che porta un messaggio', () => {
    for (const trigger of ['trigger_imap', 'trigger_webhook', 'trigger_telegram']) {
      const input = {
        nodes: [
          { id: 't', defId: trigger, config: {} },
          { id: 'riassunto', defId: 'agent_summarizer', config: {} },
        ],
        edges: [{ from: 't', to: 'riassunto' }],
      };
      expect(checkNienteDaElaborare(input)).toEqual([]);
    }
  });

  /** Un nodo scollegato è un altro difetto, con il suo controllo. */
  it('non tocca un nodo senza niente a monte', () => {
    const input = {
      nodes: [{ id: 'riassunto', defId: 'agent_summarizer', config: {} }],
      edges: [],
    };
    expect(checkNienteDaElaborare(input)).toEqual([]);
  });
});
