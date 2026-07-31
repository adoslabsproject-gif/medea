/**
 * La validazione è la garanzia dello scaffold: nessun workflow rotto può
 * essere salvato. Ogni ViolationKind ha qui almeno un caso che lo produce e
 * uno che non lo produce — e i messaggi devono dire al modello cosa è
 * ammesso, non solo cosa è vietato.
 */

import { describe, expect, it } from 'vitest';

import { indexByDefId } from './catalog';
import { at, CATALOG, makeValid } from './fixtures';
import {
  describeViolations,
  isPickerField,
  validateGraph,
  validateNodes,
  validateScaffold,
  type Violation,
} from './validate';

const INDEX = indexByDefId(CATALOG);

describe('nodi e configurazione', () => {
  it('accetta un workflow corretto', () => {
    expect(validateScaffold(makeValid(), INDEX)).toHaveLength(0);
  });

  it('rifiuta un defId che non esiste, suggerendo il catalogo', () => {
    const out = makeValid();
    at(out.nodes, 1).defId = 'action_inventato';
    const v = validateScaffold(out, INDEX);
    expect(v[0]?.kind).toBe('unknown_def');
    expect(v[0]?.message).toContain('action_inventato');
  });

  it("rifiuta un valore fuori dall'enum, elencando quelli ammessi", () => {
    const out = makeValid();
    at(out.nodes, 1).config.method = 'FETCH';
    const v = validateScaffold(out, INDEX);
    expect(v[0]?.kind).toBe('invalid_enum');
    expect(v[0]?.message).toContain('GET | POST | PUT | DELETE');
  });

  it('rifiuta un valore enum non-stringa: un oggetto non è mai un enum', () => {
    const out = makeValid();
    at(out.nodes, 1).config.method = { verb: 'GET' };
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'invalid_enum')).toBe(true);
  });

  it('tollera null su un enum opzionale: vale come assenza', () => {
    const out = makeValid();
    at(out.nodes, 1).config.method = null;
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'invalid_enum')).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['stringa vuota', ''],
    ['null', null],
  ])('un campo obbligatorio a %s è mancante', (_label, value) => {
    const out = makeValid();
    if (value === undefined) delete at(out.nodes, 2).config.subject;
    else at(out.nodes, 2).config.subject = value;
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'missing_required')).toBe(true);
  });

  it('non incolpa il modello per i campi picker: li sceglie l’utente', () => {
    const out = makeValid();
    out.nodes.push({ id: 'save', defId: 'db_insert', config: {} });
    out.edges.push({ from: 'notify', to: 'save' });
    expect(validateScaffold(out, INDEX).some((v) => v.kind === 'missing_required')).toBe(false);
  });

  it('rifiuta un campo che non appartiene al nodo, elencando quelli veri', () => {
    const out = makeValid();
    at(out.nodes, 1).config.timeoutMs = 5000;
    const v = validateScaffold(out, INDEX).find((x) => x.kind === 'unknown_config_key');
    expect(v?.field).toBe('timeoutMs');
    expect(v?.message).toContain('url, method');
  });

  it('rifiuta un’azione che il nodo non ha, e accetta quelle vere', () => {
    const out = makeValid();
    out.nodes.push({ id: 'memo', defId: 'action_notes', config: { action: 'note_delete' } });
    out.edges.push({ from: 'notify', to: 'memo' });
    const v = validateNodes(out, INDEX).find((x) => x.kind === 'invalid_action');
    expect(v?.message).toContain('note_add');
    at(out.nodes, 3).config.action = 'note_add';
    expect(validateNodes(out, INDEX).some((x) => x.kind === 'invalid_action')).toBe(false);
  });
});

describe('grafo', () => {
  it('rifiuta id duplicati', () => {
    const out = makeValid();
    at(out.nodes, 2).id = 'fetch';
    expect(validateGraph(out, INDEX).some((v) => v.kind === 'duplicate_id')).toBe(true);
  });

  it('rifiuta collegamenti da e verso nodi inesistenti', () => {
    const out = makeValid();
    out.edges.push({ from: 'fantasma', to: 'notify' }, { from: 'notify', to: 'nulla' });
    const kinds = validateGraph(out, INDEX).filter((v) => v.kind === 'dangling_edge');
    expect(kinds).toHaveLength(2);
  });

  it('rifiuta un nodo collegato a sé stesso', () => {
    const out = makeValid();
    out.edges.push({ from: 'notify', to: 'notify' });
    expect(validateGraph(out, INDEX).some((v) => v.kind === 'self_loop')).toBe(true);
  });

  it('rifiuta una porta inventata, elencando quelle vere', () => {
    const out = makeValid();
    out.nodes.push({ id: 'check', defId: 'logic_if', config: { conditionRules: '[]' } });
    out.edges.push({ from: 'check', to: 'notify', fromPort: 'forse' });
    const v = validateGraph(out, INDEX).find((x) => x.kind === 'invalid_port');
    expect(v?.message).toContain('true | false');
  });

  it('accetta fromPort su nodi che non dichiarano porte', () => {
    const out = makeValid();
    at(out.edges, 0).fromPort = 'main';
    expect(validateGraph(out, INDEX).some((v) => v.kind === 'invalid_port')).toBe(false);
  });
});

describe('composizione', () => {
  it('validateScaffold somma nodi, grafo e tabelle', () => {
    const out = makeValid();
    at(out.nodes, 1).defId = 'action_inventato';
    out.edges.push({ from: 'x', to: 'y' });
    out.tablesToCreate = [{ name: 'DROP TABLE messages', columns: [] }];
    const kinds = new Set(validateScaffold(out, INDEX).map((v) => v.kind));
    expect(kinds.has('unknown_def')).toBe(true);
    expect(kinds.has('dangling_edge')).toBe(true);
    expect(kinds.has('invalid_table')).toBe(true);
  });

  it('isPickerField riconosce solo i tipi picker', () => {
    expect(isPickerField('db-picker')).toBe(true);
    expect(isPickerField('string')).toBe(false);
  });
});

describe('describeViolations — il testo che rilegge il modello', () => {
  const many: Violation[] = Array.from({ length: 15 }, (_, i) => ({
    kind: 'unknown_def',
    message: `problema ${i}`,
  }));

  it('numera le violazioni', () => {
    const text = describeViolations(many.slice(0, 2));
    expect(text).toBe('1. problema 0\n2. problema 1');
  });

  it('tronca a 12 dichiarando quante ne restano', () => {
    const text = describeViolations(many);
    expect(text).toContain('12. problema 11');
    expect(text).not.toContain('problema 12');
    expect(text).toContain('…e altri 3 problemi');
  });

  it('rispetta un limite personalizzato', () => {
    expect(describeViolations(many, 1)).toContain('…e altri 14 problemi');
  });
});
