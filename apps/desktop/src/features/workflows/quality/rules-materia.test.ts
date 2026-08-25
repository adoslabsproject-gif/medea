/**
 * Un nodo che elabora un contenuto che non gli arriva mai — lato editor.
 *
 * Il caso vero: «riassunto_serale», 2026-08-06. `trigger_cron →
 * agent_summarizer`, e nessun nodo che leggesse la posta.
 *
 * Metà dei test serve a dimostrare quando la regola deve TACERE: una regola
 * sul senso del flusso, sbagliata, blocca lavoro legittimo.
 *
 * @module features/workflows/quality/rules-materia.test
 */

import { describe, expect, it } from 'vitest';

import { checkNienteDaElaborare } from './rules-materia';
import type { QualityGateInput, QualityNodeDef } from './types';

const DEFS = new Map<string, QualityNodeDef>([
  ['trigger_cron', { type: 'trigger' }],
  ['trigger_imap', { type: 'trigger' }],
  ['trigger_manual', { type: 'trigger' }],
  ['action_fetch_url', { type: 'action' }],
  ['agent_summarizer', { type: 'ai', configFields: [{ key: 'provider' }, { key: 'model' }] }],
  ['ai_openai', { type: 'ai', configFields: [{ key: 'apiKey' }, { key: 'prompt' }] }],
  ['ai_agent_tool_loop', { type: 'ai', configFields: [{ key: 'goal' }] }],
]);

const con = (
  nodes: { id: string; defId: string }[],
  edges: { from: string; to: string }[],
): QualityGateInput => ({
  nodes: nodes.map((n) => ({ ...n, config: {} })),
  edges,
  defs: DEFS,
});

describe('il caso che è passato', () => {
  it('lo prende, e dice cosa manca', () => {
    const issues = checkNienteDaElaborare(
      con(
        [
          { id: 'cron', defId: 'trigger_cron' },
          { id: 'riassunto', defId: 'agent_summarizer' },
        ],
        [{ from: 'cron', to: 'riassunto' }],
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('critical');
    expect(issues[0]?.message).toContain('la posta da leggere');
  });
});

describe('quello che deve restare fuori', () => {
  it('cron → scarica → riassumi: il contenuto c’è', () => {
    expect(
      checkNienteDaElaborare(
        con(
          [
            { id: 'cron', defId: 'trigger_cron' },
            { id: 'scarica', defId: 'action_fetch_url' },
            { id: 'riassunto', defId: 'agent_summarizer' },
          ],
          [
            { from: 'cron', to: 'scarica' },
            { from: 'scarica', to: 'riassunto' },
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('un nodo con il proprio prompt non aspetta niente', () => {
    expect(
      checkNienteDaElaborare(
        con(
          [
            { id: 'cron', defId: 'trigger_cron' },
            { id: 'llm', defId: 'ai_openai' },
          ],
          [{ from: 'cron', to: 'llm' }],
        ),
      ),
    ).toEqual([]);
  });

  it('un agente con un obiettivo proprio nemmeno', () => {
    expect(
      checkNienteDaElaborare(
        con(
          [
            { id: 'cron', defId: 'trigger_cron' },
            { id: 'agente', defId: 'ai_agent_tool_loop' },
          ],
          [{ from: 'cron', to: 'agente' }],
        ),
      ),
    ).toEqual([]);
  });

  it('l’avvio manuale porta il testo che si incolla', () => {
    expect(
      checkNienteDaElaborare(
        con(
          [
            { id: 'start', defId: 'trigger_manual' },
            { id: 'riassunto', defId: 'agent_summarizer' },
          ],
          [{ from: 'start', to: 'riassunto' }],
        ),
      ),
    ).toEqual([]);
  });

  it('un trigger che porta un messaggio nemmeno', () => {
    expect(
      checkNienteDaElaborare(
        con(
          [
            { id: 'posta', defId: 'trigger_imap' },
            { id: 'riassunto', defId: 'agent_summarizer' },
          ],
          [{ from: 'posta', to: 'riassunto' }],
        ),
      ),
    ).toEqual([]);
  });

  it('un nodo scollegato è un altro difetto, con un altro controllo', () => {
    expect(
      checkNienteDaElaborare(con([{ id: 'riassunto', defId: 'agent_summarizer' }], [])),
    ).toEqual([]);
  });

  /** Senza le definizioni non si può sapere niente. */
  it('senza le definizioni non inventa segnalazioni', () => {
    const input = con(
      [
        { id: 'cron', defId: 'trigger_cron' },
        { id: 'riassunto', defId: 'agent_summarizer' },
      ],
      [{ from: 'cron', to: 'riassunto' }],
    );
    delete (input as { defs?: unknown }).defs;
    expect(checkNienteDaElaborare(input)).toEqual([]);
  });
});
