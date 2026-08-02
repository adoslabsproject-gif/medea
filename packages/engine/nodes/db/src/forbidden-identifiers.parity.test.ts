/**
 * PARITY GUARD anti-drift — il guard del sandbox `new Function` di
 * `db_insert_batch.childRowsExpression` (DB_FORBIDDEN_IDENTIFIERS) è una COPIA
 * di quello canonico in `apps/engine/src/engine/interpreter.ts`
 * (FORBIDDEN_IDENTIFIERS). Le copie DERIVANO: il 2026-06-20 la copia db si era
 * persa `Proxy`/`Reflect`/`WeakRef` (aggiunti all'interpreter) → childRowsExpression
 * era l'anello debole (sandbox-escape via Reflect/Proxy).
 *
 * Questo test ASSERISCE che la copia db sia un SUPERSET dell'originale: se
 * qualcuno aggiunge un identifier vietato all'interpreter ma NON a db, qui
 * diventa ROSSO. (Finché le due liste non sono promosse a un pacchetto condiviso
 * `@medea/engine-expression-guard`, questa è la rete che impedisce la divergenza.)
 *
 * @module forbidden-identifiers.parity
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dbIndex = readFileSync(join(here, 'index.ts'), 'utf8');
const interpreter = readFileSync(
  join(here, '..', '..', '..', '..', '..', 'apps', 'engine', 'src', 'engine', 'interpreter.ts'),
  'utf8',
);

/** Estrae gli identifier string-literal dell'array `<NAME> = [ … ]`.
 * Cattura SOLO literal a forma di identifier JS valido (`'eval'`, `'__proto__'`):
 * i commenti italiani dentro l'array usano apostrofi (`l'espressione`) e
 * darebbero falsi positivi con un `'[^']+'` ingenuo. */
function extractList(src: string, name: string): Set<string> {
  const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (!m) throw new Error(`array ${name} non trovato (rinominato/spostato?)`);
  return new Set([...(m[1] ?? '').matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((x) => x[1]!));
}

describe('🚨 parity — DB_FORBIDDEN_IDENTIFIERS ⊇ interpreter FORBIDDEN_IDENTIFIERS', () => {
  const dbSet = extractList(dbIndex, 'DB_FORBIDDEN_IDENTIFIERS');
  const intSet = extractList(interpreter, 'FORBIDDEN_IDENTIFIERS');

  it('entrambe le liste sono non vuote (sanity: regex/path validi)', () => {
    expect(dbSet.size).toBeGreaterThan(10);
    expect(intSet.size).toBeGreaterThan(10);
  });

  it('🚨 db NON deve mancare nessun identifier dell\'interpreter (no drift debole)', () => {
    const missing = [...intSet].filter((id) => !dbSet.has(id));
    expect(missing, `la copia db ha perso identifier vietati dall'interpreter: ${missing.join(', ')}`).toEqual([]);
  });

  it('include i recenti Proxy/Reflect/WeakRef (anti-regressione del drift 2026-06-20)', () => {
    for (const id of ['Proxy', 'Reflect', 'WeakRef']) {
      expect(dbSet.has(id), `${id} deve essere in DB_FORBIDDEN_IDENTIFIERS`).toBe(true);
    }
  });
});
