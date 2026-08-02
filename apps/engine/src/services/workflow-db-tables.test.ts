import { describe, it, expect } from 'vitest';
import {
  extractDbTableRefs,
  dedicatedTablesToDrop,
  WRITE_DB_DEFIDS,
  ANY_DB_DEFIDS,
} from './workflow-db-tables.js';

const n = (defId: string, databaseId: string, table: string) => ({
  defId,
  config: { databaseId, table },
});

describe('extractDbTableRefs', () => {
  it('estrae solo i defId richiesti + dedup + skip espressioni {{}}', () => {
    const nodes = [
      n('db_insert', 'd1', 'price_monitoring'),
      n('db_query', 'd1', 'legacy_urls'),
      n('db_insert', 'd1', 'price_monitoring'), // dup
      n('db_insert', 'd1', '{{$node.x.table}}'), // espressione → skip
      { defId: 'action_http', config: {} }, // non-db
    ];
    expect(extractDbTableRefs(nodes, WRITE_DB_DEFIDS)).toEqual([
      { databaseId: 'd1', table: 'price_monitoring' },
    ]);
    expect(extractDbTableRefs(nodes, ANY_DB_DEFIDS)).toEqual([
      { databaseId: 'd1', table: 'price_monitoring' },
      { databaseId: 'd1', table: 'legacy_urls' },
    ]);
  });
  it('nodi non-array / malformati → []', () => {
    expect(extractDbTableRefs(null, ANY_DB_DEFIDS)).toEqual([]);
    expect(extractDbTableRefs([null, {}, { defId: 'db_insert' }], ANY_DB_DEFIDS)).toEqual([]);
  });
});

describe('dedicatedTablesToDrop — anti-dataloss', () => {
  it('tabella scritta SOLO da questo workflow → droppabile', () => {
    const target = [n('db_insert', 'd1', 'price_monitoring')];
    const others = [[n('db_insert', 'd1', 'orders')]];
    expect(dedicatedTablesToDrop(target, others)).toEqual([
      { databaseId: 'd1', table: 'price_monitoring' },
    ]);
  });
  it('tabella USATA (anche solo letta) da un altro workflow → NON droppata', () => {
    const target = [n('db_insert', 'd1', 'shared')];
    const others = [[n('db_query', 'd1', 'shared')]]; // un altro la LEGGE
    expect(dedicatedTablesToDrop(target, others)).toEqual([]);
  });
  it('tabella solo LETTA dal target (non scritta) → mai droppata', () => {
    const target = [n('db_query', 'd1', 'lookup')];
    expect(dedicatedTablesToDrop(target, [])).toEqual([]);
  });
  it('stesso nome ma DB diverso → tabelle distinte', () => {
    const others = [[n('db_insert', 'dB', 'logs')]]; // logs su dB ≠ dA
    expect(dedicatedTablesToDrop([n('db_insert', 'dA', 'logs')], others)).toEqual([
      { databaseId: 'dA', table: 'logs' },
    ]);
  });
});
