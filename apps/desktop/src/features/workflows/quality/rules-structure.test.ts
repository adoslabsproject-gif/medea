/**
 * Le regole che guardano il disegno del flusso e la forma dei dati.
 *
 * Per ciascuna c'è il caso che deve essere segnalato e, dove conta, il caso
 * legittimo che le assomiglia e NON deve esserlo.
 */

import { describe, expect, it } from 'vitest';

import { codes, edge, input, node } from './fixtures';
import {
  checkCircularReferences,
  checkDeadEnd,
  checkDuplicateNodes,
  checkOrphanTriggers,
} from './rules-graph';
import {
  checkAggregationInsideLoop,
  checkArrayToScalarWithoutLoop,
  checkFanInWithoutMerge,
} from './rules-shape';

describe('riferimenti fra nodi', () => {
  it('segnala il riferimento a un nodo che non esiste', () => {
    const issues = checkCircularReferences(
      input([node('invia', 'action_send_email', { subject: '{{$node.fantasma.json.titolo}}' })]),
    );
    expect(issues[0]?.message).toContain('non esiste');
  });

  it('segnala il nodo che legge se stesso', () => {
    const issues = checkCircularReferences(
      input([node('a', 'action_http', { url: '{{$node.a.json.url}}' })]),
    );
    expect(issues[0]?.message).toContain('se stesso');
  });

  it('segnala il riferimento a un nodo che viene dopo', () => {
    const issues = checkCircularReferences(
      input(
        [
          node('primo', 'action_http', { url: '{{$node.secondo.json.url}}' }),
          node('secondo', 'action_http', { url: 'https://reale.it' }),
        ],
        [edge('primo', 'secondo')],
      ),
    );
    expect(issues[0]?.message).toContain('non viene prima');
  });

  it('accetta il riferimento a un nodo che viene prima', () => {
    const issues = checkCircularReferences(
      input(
        [
          node('primo', 'action_http', { url: 'https://reale.it' }),
          node('secondo', 'action_send_email', { subject: '{{$node.primo.json.titolo}}' }),
        ],
        [edge('primo', 'secondo')],
      ),
    );
    expect(issues).toEqual([]);
  });

  it('guarda anche dentro i valori non testuali', () => {
    const issues = checkCircularReferences(
      input([node('a', 'db_insert', { rowJson: { titolo: '{{$node.b.json.x}}' } })]),
    );
    expect(codes(issues)).toEqual(['CIRCULAR_REFERENCE']);
  });
});

describe('trigger e rami sospesi', () => {
  it('segnala il trigger che non porta a nulla', () => {
    const issues = checkOrphanTriggers(input([node('avvio', 'trigger_cron', {})]));
    expect(codes(issues)).toEqual(['ORPHAN_TRIGGER']);
  });

  it('non segnala un punto di arrivo legittimo', () => {
    const issues = checkDeadEnd(
      input(
        [node('avvio', 'trigger_cron'), node('invia', 'action_send_email')],
        [edge('avvio', 'invia')],
      ),
    );
    expect(issues).toEqual([]);
  });

  it('segnala il nodo intermedio che finisce nel vuoto', () => {
    const issues = checkDeadEnd(
      input(
        [node('avvio', 'trigger_cron'), node('estrai', 'agent_extractor')],
        [edge('avvio', 'estrai')],
      ),
    );
    expect(issues[0]?.nodeId).toBe('estrai');
  });
});

describe('nodi duplicati', () => {
  it('riconosce due nodi con la stessa configurazione', () => {
    const issues = checkDuplicateNodes(
      input([
        node('log1', 'db_insert', { table: 'audit', rowJson: '{"a":1}' }),
        node('log2', 'db_insert', { table: 'audit', rowJson: '{"a":1}' }),
      ]),
    );
    expect(issues[0]?.message).toContain('log1, log2');
  });

  it('non confonde due nodi con configurazione diversa', () => {
    const issues = checkDuplicateNodes(
      input([
        node('log1', 'db_insert', { table: 'audit' }),
        node('log2', 'db_insert', { table: 'eventi' }),
      ]),
    );
    expect(issues).toEqual([]);
  });
});

describe('forma dei dati', () => {
  it('segnala la lista collegata a chi elabora un elemento per volta', () => {
    const issues = checkArrayToScalarWithoutLoop(
      input([node('righe', 'db_query'), node('scrivi', 'db_insert')], [edge('righe', 'scrivi')]),
    );
    expect(codes(issues)).toEqual(['ARRAY_TO_SCALAR_WITHOUT_LOOP']);
  });

  it('accetta lo stesso collegamento se in mezzo c’è un ciclo', () => {
    const issues = checkArrayToScalarWithoutLoop(
      input(
        [node('righe', 'db_query'), node('ciclo', 'logic_loop'), node('scrivi', 'db_insert')],
        [edge('righe', 'ciclo'), edge('ciclo', 'scrivi')],
      ),
    );
    expect(issues).toEqual([]);
  });

  it('segnala più rami che convergono su chi non sa unirli', () => {
    const issues = checkFanInWithoutMerge(
      input(
        [node('a', 'action_http'), node('b', 'action_http'), node('scrivi', 'db_insert')],
        [edge('a', 'scrivi'), edge('b', 'scrivi')],
      ),
    );
    expect(codes(issues)).toEqual(['FAN_IN_WITHOUT_MERGE']);
  });

  it('accetta la convergenza su un nodo che aggrega', () => {
    const issues = checkFanInWithoutMerge(
      input(
        [node('a', 'action_http'), node('b', 'action_http'), node('unisci', 'flow_merge')],
        [edge('a', 'unisci'), edge('b', 'unisci')],
      ),
    );
    expect(issues).toEqual([]);
  });
});

describe('aggregazione dentro il ciclo', () => {
  const dentroIlCiclo = (strategy: string) =>
    input(
      [
        node('ciclo', 'logic_loop', { strategy }),
        node('riepilogo', 'action_send_email', { subject: 'Report giornaliero' }),
      ],
      [edge('ciclo', 'riepilogo')],
    );

  it('segnala il riepilogo ripetuto a ogni giro', () => {
    const issues = checkAggregationInsideLoop(dentroIlCiclo('naive'));
    expect(issues[0]?.message).toContain('una volta per ogni elemento');
  });

  it('tace quando il ciclo lavora sull’intero elenco', () => {
    expect(checkAggregationInsideLoop(dentroIlCiclo('batch'))).toEqual([]);
  });
});
