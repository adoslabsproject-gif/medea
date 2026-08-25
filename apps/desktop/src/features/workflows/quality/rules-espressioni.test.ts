/**
 * Un campo scritto da solo dentro le graffe.
 *
 * Il 2026-08-06 il wizard ha prodotto «riassunto_serale» con `{{tldr}}` nel
 * testo di un messaggio Slack e `{{firedAt}}` in una riga di database. I NOMI
 * erano giusti — `tldr` esce davvero da `agent_summarizer`, `firedAt` da
 * `trigger_cron`: i contratti di output stavano funzionando. Mancava il
 * prefisso, e senza quello l'interprete non trova niente e mette **stringa
 * vuota**, senza sollevare niente. Il messaggio sarebbe partito vuoto.
 *
 * Il gate diceva PASSA. La regola accanto cerca `nodo.campo` e pretende un
 * punto che qui non c'è.
 *
 * Questa verifica è possibile solo da quando ogni nodo dichiara cosa produce
 * (ADR 0010): senza, `tldr` è una parola come un'altra.
 *
 * @module features/workflows/quality/rules-espressioni.test
 */

import { describe, expect, it } from 'vitest';

import { checkEspressioniNonRisolvibili } from './rules-espressioni';
import type { QualityGateInput, QualityNodeDef } from './types';

const DEFS = new Map<string, QualityNodeDef>([
  ['trigger_cron', { outputContract: { fields: [{ name: 'firedAt' }, { name: 'timezone' }] } }],
  ['agent_summarizer', { outputContract: { fields: [{ name: 'tldr' }, { name: 'bullets' }] } }],
  ['community_slack', { outputContract: { fields: [{ name: 'ts' }] } }],
]);

function disegno(configSlack: Record<string, unknown>): QualityGateInput {
  return {
    nodes: [
      { id: 'cron', defId: 'trigger_cron', config: {} },
      { id: 'riassunto', defId: 'agent_summarizer', config: {} },
      { id: 'slack', defId: 'community_slack', config: configSlack },
    ],
    edges: [
      { from: 'cron', to: 'riassunto' },
      { from: 'riassunto', to: 'slack' },
    ],
    defs: DEFS,
  };
}

describe('un campo nudo che un nodo a monte produce davvero', () => {
  it('lo segnala e dice come si scrive', () => {
    const issues = checkEspressioniNonRisolvibili(disegno({ text: 'Oggi:\n{{tldr}}' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('critical');
    expect(issues[0]?.message).toContain('{{$node.riassunto.json.tldr}}');
  });

  /** Salta un nodo: `firedAt` viene dal trigger, due passi più su. */
  it('lo trova anche se il produttore non è il nodo immediatamente prima', () => {
    const issues = checkEspressioniNonRisolvibili(disegno({ text: '{{firedAt}}' }));
    expect(issues[0]?.message).toContain('{{$node.cron.json.firedAt}}');
  });

  it('la forma giusta non fa rumore', () => {
    const issues = checkEspressioniNonRisolvibili(
      disegno({ text: '{{$node.riassunto.json.tldr}}' }),
    );
    expect(issues).toEqual([]);
  });
});

describe('quello che deve restare fuori', () => {
  /**
   * Le radici dello scope esistono davvero: `input` è il modo documentato di
   * leggere dal nodo precedente, e segnalarlo manderebbe a «correggere» codice
   * giusto.
   */
  it('non tocca le radici dello scope', () => {
    for (const radice of ['input', 'secrets', 'vars', 'loop', 'item', 'index', 'output', 'ctx']) {
      expect(checkEspressioniNonRisolvibili(disegno({ text: `{{${radice}}}` }))).toEqual([]);
    }
  });

  it('non tocca una parola che nessun nodo a monte produce', () => {
    expect(checkEspressioniNonRisolvibili(disegno({ text: '{{pippo}}' }))).toEqual([]);
  });

  /**
   * Il campo esiste, ma su un nodo che sta a VALLE: non è il caso che
   * conosciamo, e inventare una correzione sbagliata è peggio che tacere.
   */
  it('non propone un nodo che sta a valle', () => {
    const input: QualityGateInput = {
      nodes: [
        { id: 'slack', defId: 'community_slack', config: { text: '{{tldr}}' } },
        { id: 'riassunto', defId: 'agent_summarizer', config: {} },
      ],
      edges: [{ from: 'slack', to: 'riassunto' }],
      defs: DEFS,
    };
    expect(checkEspressioniNonRisolvibili(input)).toEqual([]);
  });

  it('non tocca chiamate di funzione né espressioni composte', () => {
    expect(checkEspressioniNonRisolvibili(disegno({ text: '{{ now() }}' }))).toEqual([]);
    expect(checkEspressioniNonRisolvibili(disegno({ text: '{{ tldr + 1 }}' }))).toEqual([]);
  });

  /** Senza contratti non si può sapere niente: meglio tacere che sbagliare. */
  it('senza le definizioni non inventa segnalazioni', () => {
    const senzaDefs = { ...disegno({ text: '{{tldr}}' }) };
    delete (senzaDefs as { defs?: unknown }).defs;
    expect(checkEspressioniNonRisolvibili(senzaDefs)).toEqual([]);
  });
});
