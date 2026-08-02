import { describe, it, expect } from 'vitest';
import { healDbTableReferences, type DbHealNode, type DbHealDatabase } from './heal-db-table.js';

const DB: DbHealDatabase = {
  id: 'db1',
  columns: {
    orders: ['id', 'subject', 'attachment_path', 'created_at'],
    price_monitoring: ['id', 'url', 'price', 'median_price', 'timestamp'],
    customers: ['id', 'email', 'name', 'created_at'],
  },
};
const insert = (table: string, rowJson: string): DbHealNode => ({
  id: 'ins',
  defId: 'db_insert',
  config: { databaseId: 'db1', table, rowJson },
});

describe('healDbTableReferences — caso REALE Anti-fraud (nicola-cucurachi)', () => {
  it('db_insert su "orders" con colonne prezzo → RIPUNTA a "price_monitoring" (esiste e matcha)', () => {
    const node = insert('orders', '{"url":"x","price":"1","median_price":"2","timestamp":"t"}');
    const r = healDbTableReferences([node], [DB], 'anti-fraud price monitoring');
    expect(node.config.table).toBe('price_monitoring'); // ripuntato
    expect(r.tablesToCreate).toEqual([]); // nessuna tabella creata (matcha)
    expect(r.notes[0]).toMatch(/ripuntato.*orders.*price_monitoring/);
  });

  it('tabella corretta già → nessuna modifica (no-op)', () => {
    const node = insert('price_monitoring', '{"url":"x","price":"1"}');
    const r = healDbTableReferences([node], [DB], 'x');
    expect(node.config.table).toBe('price_monitoring');
    expect(r.tablesToCreate).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});

describe('healDbTableReferences — CREA quando serve', () => {
  it('tabella nominata ma INESISTENTE → la dichiara in tablesToCreate (nome scelto da Liara)', () => {
    const node = insert('seo_audits', '{"url":"x","score":"90","audit_date":"d"}');
    const r = healDbTableReferences([node], [DB], 'seo audit');
    expect(node.config.table).toBe('seo_audits'); // nome invariato
    expect(r.tablesToCreate).toHaveLength(1);
    expect(r.tablesToCreate[0]!.name).toBe('seo_audits');
    const cols = r.tablesToCreate[0]!.columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'url', 'score', 'audit_date']));
  });

  it('tabella RICICLATA senza match → crea tabella DEDICATA dal goal + ripunta', () => {
    const node = insert('customers', '{"hop_count":"3","loop_detected":"true","final_url":"u"}'); // customers non ha queste cols, niente match
    const r = healDbTableReferences([node], [DB], 'Redirect Chain Audit');
    expect(node.config.table).not.toBe('customers'); // ripuntato a una nuova
    expect(r.tablesToCreate).toHaveLength(1);
    expect(r.tablesToCreate[0]!.name).toMatch(/redirect_chain_audit/);
    expect(node.config.table).toBe(r.tablesToCreate[0]!.name);
  });

  it('tipi inferiti: id→uuid/pk, *price→decimal, *_at/date→datetime, *count→integer, detected→boolean', () => {
    const node = insert(
      'nuova',
      '{"price":"1","created_at":"x","hop_count":"2","loop_detected":"y"}',
    );
    const r = healDbTableReferences([node], [DB], 'g');
    const byName = Object.fromEntries(r.tablesToCreate[0]!.columns.map((c) => [c.name, c]));
    expect(byName.id).toMatchObject({ type: 'uuid', primaryKey: true });
    expect(byName.price!.type).toBe('decimal');
    expect(byName.created_at!.type).toBe('datetime');
    expect(byName.hop_count!.type).toBe('integer');
    expect(byName.loop_detected!.type).toBe('boolean');
  });
});

describe('healDbTableReferences — conservativo', () => {
  it('colonne tutte {{espressioni}} → skip (niente colonne letterali)', () => {
    const node = insert('orders', '{"{{$node.x.json}}":"y"}');
    const r = healDbTableReferences([node], [DB], 'g');
    expect(node.config.table).toBe('orders'); // invariato
    expect(r.tablesToCreate).toEqual([]);
  });

  it('databaseId non risolto (db non in lista) → skip (lo gestisce resolveDatabaseId)', () => {
    const node: DbHealNode = {
      id: 'i',
      defId: 'db_insert',
      config: { databaseId: 'ghost', table: 'orders', rowJson: '{"price":"1"}' },
    };
    const r = healDbTableReferences([node], [DB], 'g');
    expect(node.config.table).toBe('orders');
    expect(r.tablesToCreate).toEqual([]);
  });
});

describe('🔒 healDbTableReferences — guard __USE_PICKER__ su table (heal pre-validation 2026-06-12)', () => {
  it('table=__USE_PICKER__ con databaseId reale → SKIP totale (MAI creare una tabella chiamata "__USE_PICKER__")', () => {
    const node: DbHealNode = {
      id: 'ins',
      defId: 'db_insert',
      config: { databaseId: 'db1', table: '__USE_PICKER__', rowJson: '{"url":"x","price":"1"}' },
    };
    const r = healDbTableReferences([node], [DB], 'goal qualunque');
    expect(node.config.table).toBe('__USE_PICKER__'); // intoccato: lo risolve la UI
    expect(r.tablesToCreate).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});
