/**
 * Bug-bounty INTEGRAZIONE — tabelle scoperte dall'audit coverage 2026-06-12:
 * integration_webhook_events + b2b_{leads,gdpr_consents,orders}.
 *
 * PERCHÉ QUESTO FILE: l'audit ha mostrato che NESSUN test esercitava queste
 * tabelle col DDL REALE. Le b2b_* sono scritte dai WORKFLOW dei tenant
 * (db_insert dinamico — Lead Hunter / GDPR Consent / Commercial Pipeline),
 * quindi i CHECK/UNIQUE del DDL sono l'UNICO guardrail contro dati sporchi.
 * integration_webhook_events ha consumatori al 98% di coverage… che mockano
 * sqlite: la semantica INSERT OR IGNORE + UNIQUE non era MAI stata
 * verificata contro lo schema vero (stesso pattern del bug chunking_version:
 * ingest e retrieval verdi separatamente, contratto rotto in mezzo).
 *
 * Qui: DB SQLite REALE (per-worker, migrato dal vitest.setup con il
 * migrate.ts di produzione) + violazioni esplicite dei constraint + contratto
 * anti-drift route↔schema (le colonne nell'INSERT della route devono
 * esistere nel PRAGMA table_info reale).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '@/storage/db.js';
import { runMigrations } from '@/storage/migrate.js';

beforeAll(() => { runMigrations(); }); // schema REALE di produzione sul DB per-worker

interface Sqlite {
  prepare: (sql: string) => {
    run: (...p: unknown[]) => { changes: number };
    get: (...p: unknown[]) => unknown;
    all: (...p: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
}

const db = (): Sqlite => getDatabase().sqlite as unknown as Sqlite;
/** Prefisso tenant univoco del file: il cleanup non tocca dati di altri test. */
const T = `test-b2baudit-${Date.now().toString(36)}`;
let seq = 0;
const id = (): string => `${T}-row-${(seq += 1).toString()}`;

afterAll(() => {
  for (const table of ['integration_webhook_events', 'b2b_leads', 'b2b_gdpr_consents', 'b2b_orders']) {
    db().prepare(`DELETE FROM ${table} WHERE tenant_id LIKE ?`).run(`${T}%`);
  }
});

// ════════════════════════════════════════════════════════════════════
// integration_webhook_events — dedup idempotente sui retry del provider
// ════════════════════════════════════════════════════════════════════
describe('integration_webhook_events (DDL reale)', () => {
  const insert = (over: Partial<Record<string, string | number>> = {}): { changes: number } =>
    db().prepare(`
      INSERT OR IGNORE INTO integration_webhook_events
        (id, provider, tenant_id, event_id_external, event_type, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      (over.id as string | undefined) ?? id(),
      over.provider ?? 'stripe',
      over.tenant_id ?? T,
      over.event_id_external ?? 'evt_dup_1',
      over.event_type ?? 'payment_intent.succeeded',
      over.payload_json ?? '{}',
    );

  it('UNIQUE(provider, event_id_external): il RETRY del provider è ignorato (changes=0, UNA riga) — il cuore anti-doppio-processing', () => {
    expect(insert().changes).toBe(1);
    expect(insert().changes).toBe(0); // retry Stripe: INSERT OR IGNORE assorbe
    const rows = db().prepare(
      'SELECT COUNT(*) AS n FROM integration_webhook_events WHERE tenant_id = ? AND event_id_external = ?',
    ).get(T, 'evt_dup_1') as { n: number };
    expect(rows.n).toBe(1);
  });

  it('stesso event_id_external su PROVIDER diverso → entrambe le righe (la chiave è composita, non globale)', () => {
    expect(insert({ event_id_external: 'evt_x_prov', provider: 'stripe' }).changes).toBe(1);
    expect(insert({ event_id_external: 'evt_x_prov', provider: 'whatsapp' }).changes).toBe(1);
  });

  it('NOT NULL: payload_json/event_type mancanti → il DDL rigetta (niente eventi mutilati in tabella)', () => {
    expect(() => db().prepare(
      'INSERT INTO integration_webhook_events (id, provider, tenant_id, event_id_external, event_type, payload_json) VALUES (?,?,?,?,?,NULL)',
    ).run(id(), 'stripe', T, 'evt_nn_1', 'x')).toThrow(/NOT NULL/i);
    expect(() => db().prepare(
      'INSERT INTO integration_webhook_events (id, provider, tenant_id, event_id_external, event_type, payload_json) VALUES (?,?,?,?,NULL,?)',
    ).run(id(), 'stripe', T, 'evt_nn_2', '{}')).toThrow(/NOT NULL/i);
  });

  it('default: received_at ISO-8601 parsabile, signature_valid=0 (fail-closed: non firmato finché non verificato)', () => {
    insert({ event_id_external: 'evt_defaults' });
    const row = db().prepare(
      'SELECT received_at, signature_valid, processed_at FROM integration_webhook_events WHERE tenant_id = ? AND event_id_external = ?',
    ).get(T, 'evt_defaults') as { received_at: string; signature_valid: number; processed_at: string | null };
    expect(() => new Date(row.received_at).toISOString()).not.toThrow();
    expect(row.signature_valid).toBe(0);
    expect(row.processed_at).toBeNull();
  });

  it('CONTRATTO anti-drift route↔schema: ogni colonna usata dalle SQL di integrations-webhooks.ts ESISTE nella tabella reale', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const routeSrc = readFileSync(join(here, '..', 'routes', 'integrations-webhooks.ts'), 'utf-8');
    // L'INSERT della route (il route-test mocka sqlite: questo è l'unico
    // punto che lega le sue stringhe SQL allo schema vero).
    const ins = /INSERT OR IGNORE INTO integration_webhook_events\s*\(([^)]+)\)/.exec(routeSrc);
    expect(ins, 'INSERT della route non trovato — contratto da riallineare').toBeTruthy();
    const realCols = new Set(
      (db().prepare('PRAGMA table_info(integration_webhook_events)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const col of ins![1]!.split(',').map((s) => s.trim())) {
      expect(realCols.has(col), `la route inserisce la colonna "${col}" che NON esiste nello schema`).toBe(true);
    }
    expect(routeSrc).toMatch(/UPDATE integration_webhook_events/);
  });
});

// ════════════════════════════════════════════════════════════════════
// b2b_gdpr_consents — audit trail consensi: i CHECK sono il guardrail GDPR
// ════════════════════════════════════════════════════════════════════
describe('b2b_gdpr_consents (DDL reale)', () => {
  const insert = (action: string, method: string): void => {
    db().prepare(
      'INSERT INTO b2b_gdpr_consents (id, tenant_id, lead_id, action, method) VALUES (?,?,?,?,?)',
    ).run(id(), T, 'lead-1', action, method);
  };

  it("CHECK action: solo 'granted'/'revoked' — un workflow che scrive 'maybe' viene RIGETTATO (audit trail non inquinabile)", () => {
    insert('granted', 'email_link');
    insert('revoked', 'manual');
    expect(() => { insert('maybe', 'manual'); }).toThrow(/CHECK/i);
    expect(() => { insert('GRANTED', 'manual'); }).toThrow(/CHECK/i); // case-sensitive: enum esatto
  });

  it("CHECK method: enum chiuso — 'sms' (non previsto) → rigettato", () => {
    insert('granted', 'whatsapp');
    insert('granted', 'imported');
    expect(() => { insert('granted', 'sms'); }).toThrow(/CHECK/i);
  });

  it('NOT NULL lead_id: un consenso senza soggetto è inutilizzabile come prova → rigettato', () => {
    expect(() => db().prepare(
      'INSERT INTO b2b_gdpr_consents (id, tenant_id, lead_id, action, method) VALUES (?,?,NULL,?,?)',
    ).run(id(), T, 'granted', 'form')).toThrow(/NOT NULL/i);
  });

  it('ts default ISO-8601 (timestamp della prova sempre presente)', () => {
    insert('granted', 'form');
    const row = db().prepare(
      'SELECT ts FROM b2b_gdpr_consents WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(T) as { ts: string };
    expect(() => new Date(row.ts).toISOString()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// b2b_leads — l'indice UNIQUE PARZIALE su email è il punto più fragile
// ════════════════════════════════════════════════════════════════════
describe('b2b_leads (DDL reale)', () => {
  const insert = (over: Partial<Record<string, string | number | null>> = {}): void => {
    db().prepare(`
      INSERT INTO b2b_leads (id, tenant_id, ragione_sociale, email, status, score)
      VALUES (?,?,?,?,?,?)
    `).run(
      id(),
      (over.tenant_id as string | undefined) ?? T,
      over.ragione_sociale ?? 'Enoteca Test SRL',
      'email' in over ? (over.email as string | null) : `lead-${(seq).toString()}@x.it`,
      over.status ?? 'new',
      over.score ?? 0,
    );
  };

  it('UNIQUE parziale (tenant, LOWER(email)): stessa email con CASE diverso, stesso tenant → duplicato RIGETTATO', () => {
    insert({ email: 'Mario@Enoteca.it' });
    expect(() => { insert({ email: 'mario@enoteca.it' }); }).toThrow(/UNIQUE/i);
  });

  it('stessa email su TENANT diverso → ok (isolamento multi-tenant del dedup)', () => {
    insert({ email: 'shared@x.it' });
    insert({ email: 'shared@x.it', tenant_id: `${T}-altro` });
  });

  it("email NULL o '' ripetute → MAI bloccate (il WHERE del partial index esclude i lead senza email)", () => {
    insert({ email: null });
    insert({ email: null });
    insert({ email: '' });
    insert({ email: '' }); // 4 lead senza email: nessun UNIQUE scatta
  });

  it('CHECK score 0-100: 101 e -1 rigettati (il lead-score batch non può scrivere fuori scala)', () => {
    expect(() => { insert({ score: 101 }); }).toThrow(/CHECK/i);
    expect(() => { insert({ score: -1 }); }).toThrow(/CHECK/i);
    insert({ score: 100 }); // boundary incluso
  });

  it("CHECK status: enum chiuso — 'qualified' (inventato) rigettato, tutti i 7 stati legittimi passano", () => {
    for (const s of ['new', 'consent_pending', 'consent_yes', 'consent_no', 'customer', 'inactive', 'blocked']) {
      insert({ status: s });
    }
    expect(() => { insert({ status: 'qualified' }); }).toThrow(/CHECK/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// b2b_orders
// ════════════════════════════════════════════════════════════════════
describe('b2b_orders (DDL reale)', () => {
  const insert = (status: string): void => {
    db().prepare(
      'INSERT INTO b2b_orders (id, tenant_id, lead_id, status) VALUES (?,?,?,?)',
    ).run(id(), T, 'lead-1', status);
  };

  it("CHECK status: i 7 stati del ciclo ordine passano, 'pending' (inventato) rigettato", () => {
    for (const s of ['new', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']) insert(s);
    expect(() => { insert('pending'); }).toThrow(/CHECK/i);
  });

  it('default currency EUR + created_at ISO', () => {
    insert('new');
    const row = db().prepare(
      'SELECT currency, created_at FROM b2b_orders WHERE tenant_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(T) as { currency: string; created_at: string };
    expect(row.currency).toBe('EUR');
    expect(() => new Date(row.created_at).toISOString()).not.toThrow();
  });
});
