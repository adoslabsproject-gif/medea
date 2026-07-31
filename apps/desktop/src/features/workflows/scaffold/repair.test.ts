/**
 * Le riparazioni sono deterministiche: stesso input, stesso output, e una
 * seconda passata non deve trovare più niente da fare (idempotenza). Ogni
 * correzione va anche dichiarata nel log — una riparazione silenziosa è un
 * comportamento non osservabile, e quindi non testabile.
 */

import { describe, expect, it } from 'vitest';

import { indexByDefId } from './catalog';
import { at, CATALOG, makeValid } from './fixtures';
import {
  applyDefaultsAndNormalize,
  dedupeNodeIds,
  fixInventedDefIds,
  normalizeTables,
  pruneEdges,
  repairScaffold,
} from './repair';
import { validateScaffold } from './validate';

const INDEX = indexByDefId(CATALOG);

describe('defId inventati', () => {
  it('riconduce un defId specializzato a quello vero, anche a più suffissi', () => {
    const out = makeValid();
    at(out.nodes, 1).defId = 'action_http_clearbit_enrich';
    const log = { applied: [] as string[] };
    fixInventedDefIds(out, INDEX, log);
    expect(at(out.nodes, 1).defId).toBe('action_http');
    expect(log.applied.join(' ')).toContain('action_http_clearbit_enrich');
  });

  it('non tocca un defId a due parti senza radice nel catalogo', () => {
    // Il taglio si ferma a 2 parti: "action_fake" resta tale e sarà la
    // validazione a respingerlo con un messaggio leggibile.
    const out = makeValid();
    at(out.nodes, 1).defId = 'action_fake';
    fixInventedDefIds(out, INDEX, { applied: [] });
    expect(at(out.nodes, 1).defId).toBe('action_fake');
  });
});

describe('enum e default', () => {
  it('normalizza le maiuscole di un enum invece di bocciarlo', () => {
    const out = makeValid();
    at(out.nodes, 1).config.method = 'post';
    repairScaffold(out, INDEX);
    expect(at(out.nodes, 1).config.method).toBe('POST');
    expect(validateScaffold(out, INDEX)).toHaveLength(0);
  });

  it('porta a stringa un enum arrivato come numero o booleano', () => {
    const index = indexByDefId([
      {
        defId: 'logic_wait',
        type: 'logic',
        label: 'Attesa',
        configFields: [
          { key: 'minutes', type: 'select', options: ['1', '5', '15'] },
          { key: 'enabled', type: 'select', options: ['true', 'false'] },
        ],
      },
    ]);
    const out = makeValid();
    out.nodes = [{ id: 'wait', defId: 'logic_wait', config: { minutes: 5, enabled: true } }];
    out.edges = [];
    const log = repairScaffold(out, index);
    expect(at(out.nodes, 0).config.minutes).toBe('5');
    expect(at(out.nodes, 0).config.enabled).toBe('true');
    expect(log.applied.filter((r) => r.includes('portato a stringa'))).toHaveLength(2);
  });

  it('applica i default dichiarati quando il campo manca', () => {
    const out = makeValid();
    delete at(out.nodes, 1).config.method;
    repairScaffold(out, INDEX);
    expect(at(out.nodes, 1).config.method).toBe('GET');
  });

  it('applica il default anche su null: il "non lo so" del modello', () => {
    const out = makeValid();
    at(out.nodes, 1).config.method = null;
    const log = repairScaffold(out, INDEX);
    expect(at(out.nodes, 1).config.method).toBe('GET');
    expect(log.applied.some((r) => r.includes('default'))).toBe(true);
  });

  it('mette il segnaposto sui picker obbligatori invece di inventare', () => {
    const out = makeValid();
    out.nodes.push({ id: 'save', defId: 'db_insert', config: {} });
    out.edges.push({ from: 'notify', to: 'save' });
    repairScaffold(out, INDEX);
    expect(at(out.nodes, 3).config.databaseId).toBe('__USE_PICKER__');
    expect(at(out.nodes, 3).config.table).toBe('__USE_PICKER__');
  });
});

describe('id duplicati e collegamenti', () => {
  it('rende univoci gli id duplicati aggiornando i collegamenti', () => {
    const out = makeValid();
    at(out.nodes, 2).id = 'fetch';
    out.edges[1] = { from: 'fetch', to: 'fetch' };
    repairScaffold(out, INDEX);
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(3);
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'duplicate_id')).toBe(false);
  });

  it('salta i suffissi già occupati: mai due volte lo stesso nome', () => {
    const out = makeValid();
    out.nodes.push(
      { id: 'cron_2', defId: 'trigger_cron', config: { cron: '0 8 * * *' } },
      { id: 'cron', defId: 'trigger_cron', config: { cron: '0 7 * * *' } },
    );
    const log = { applied: [] as string[] };
    dedupeNodeIds(out, log);
    expect(out.nodes.map((n) => n.id)).toEqual(['cron', 'fetch', 'notify', 'cron_2', 'cron_3']);
  });

  it('con id duplicati i collegamenti seguono l’ultimo rinominato (caratterizzazione)', () => {
    // Un grafo con id duplicati è ambiguo per costruzione: ciò che il test
    // difende è che la risoluzione resti deterministica, non che sia "giusta".
    const out = makeValid();
    out.nodes.push({ id: 'cron', defId: 'trigger_cron', config: { cron: '0 8 * * *' } });
    dedupeNodeIds(out, { applied: [] });
    expect(at(out.edges, 0).from).toBe('cron_2');
  });

  it('rimuove doppioni, archi verso il nulla e self-loop in una passata', () => {
    const out = makeValid();
    out.edges.push(
      { from: 'cron', to: 'fetch' },
      { from: 'fetch', to: 'fantasma' },
      { from: 'notify', to: 'notify' },
    );
    const log = { applied: [] as string[] };
    pruneEdges(out, log);
    expect(out.edges).toHaveLength(2);
    expect(log.applied.join(' ')).toContain('3 collegamenti rimossi');
  });

  it('conserva due archi uguali con fromPort diverso: sono rami distinti', () => {
    const out = makeValid();
    out.nodes.push({ id: 'check', defId: 'logic_if', config: { conditionRules: '[]' } });
    out.edges.push(
      { from: 'check', to: 'notify', fromPort: 'true' },
      { from: 'check', to: 'notify', fromPort: 'false' },
    );
    pruneEdges(out, { applied: [] });
    expect(out.edges).toHaveLength(4);
  });
});

describe('tabelle e posizioni', () => {
  it('normalizza nomi e tipi delle tabelle a minuscolo', () => {
    const out = makeValid();
    out.tablesToCreate = [{ name: ' Followups ', columns: [{ name: 'ID', type: 'TEXT' }] }];
    const log = { applied: [] as string[] };
    normalizeTables(out, log);
    expect(out.tablesToCreate).toEqual([
      { name: 'followups', columns: [{ name: 'id', type: 'text' }] },
    ]);
    expect(log.applied.length).toBeGreaterThan(0);
  });

  it('assegna le posizioni mancanti senza toccare quelle esistenti', () => {
    const out = makeValid();
    at(out.nodes, 0).x = 42;
    at(out.nodes, 0).y = 7;
    repairScaffold(out, INDEX);
    expect(at(out.nodes, 0).x).toBe(42);
    expect(at(out.nodes, 0).y).toBe(7);
    expect(at(out.nodes, 1).x).toBe(220);
    expect(out.nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
  });
});

describe('idempotenza — la proprietà che regge tutto', () => {
  it('una seconda passata non trova nulla da riparare', () => {
    const out = makeValid();
    at(out.nodes, 1).defId = 'action_http_stripe';
    at(out.nodes, 1).config.method = 'post';
    at(out.nodes, 2).config.subject = null;
    out.tablesToCreate = [{ name: 'Followups', columns: [{ name: 'id', type: 'TEXT' }] }];
    repairScaffold(out, INDEX);

    const snapshot = structuredClone(out);
    const second = repairScaffold(out, INDEX);
    expect(second.applied).toEqual([]);
    expect(out).toEqual(snapshot);
  });
});

describe('applyDefaultsAndNormalize non tocca ciò che è già giusto', () => {
  it('log vuoto su un output pulito già posizionato', () => {
    const out = makeValid();
    repairScaffold(out, INDEX);
    const log = { applied: [] as string[] };
    applyDefaultsAndNormalize(out, INDEX, log);
    expect(log.applied).toEqual([]);
  });
});
