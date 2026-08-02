/**
 * Behavior + guard test — italia_woocommerce (review nodi 2026-06-20).
 *
 * Due fix verificati QUI (non solo contract statico):
 *  1. INPUT ROTTO: i campi JSON utente (data/batchData) davano un `SyntaxError`
 *     opaco di `JSON.parse`. Ora errore PULITO che nomina il campo. Il test
 *     invoca l'executor con JSON malformato e asserisce il messaggio chiaro
 *     (l'errore scatta PRIMA di qualunque rete).
 *  2. POOL: ogni fetch passa per `executeWithHostBreaker` (come fic/register-it).
 *     Guard sorgente anti-regressione: nessun `await safeFetchWithRedirects` nudo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';
import { woocommerceNode } from './index.js';

function ctx(): NodeExecutionContext {
  return { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };
}

const creds = { baseUrl: 'https://shop.example', consumerKey: 'ck_x', consumerSecret: 'cs_x' };
const run = woocommerceNode.executor!;

describe('italia_woocommerce — behavior (input rotto)', () => {
  it('🚨 create con data JSON malformato → errore PULITO che nomina il campo (no SyntaxError opaco)', async () => {
    await expect(
      run({ ...creds, action: 'create', resource: 'products', data: '{bad json' }, undefined, ctx()),
    ).rejects.toThrow(/il campo "data" non è JSON valido/);
  });

  it('🚨 update con data JSON malformato → errore PULITO (scatta prima della rete)', async () => {
    await expect(
      run({ ...creds, action: 'update', resource: 'products', id: '42', data: 'NOPE' }, undefined, ctx()),
    ).rejects.toThrow(/il campo "data" non è JSON valido/);
  });

  it('🚨 batch con batchData JSON malformato → errore PULITO che nomina batchData', async () => {
    await expect(
      run({ ...creds, action: 'batch', resource: 'products', batchData: '{,,,}' }, undefined, ctx()),
    ).rejects.toThrow(/il campo "batchData" non è JSON valido/);
  });

  it('validazione credenziali manca PRIMA del parse (baseUrl assente)', async () => {
    await expect(
      run({ action: 'create', resource: 'products', data: '{bad' }, undefined, ctx()),
    ).rejects.toThrow(/baseUrl \+ consumerKey \+ consumerSecret/);
  });
});

describe('italia_woocommerce — guard sorgente (circuit breaker)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

  it('🚨 nessun safeFetchWithRedirects awaited NUDO (deve passare dal breaker)', () => {
    expect(src).not.toMatch(/await\s+safeFetchWithRedirects\s*\(/);
  });

  it('🚨 usa executeWithHostBreaker almeno quanto chiama safeFetchWithRedirects', () => {
    const fetches = (src.match(/safeFetchWithRedirects\s*\(/g) ?? []).length;
    const breakers = (src.match(/executeWithHostBreaker\s*\(/g) ?? []).length;
    expect(fetches).toBeGreaterThan(0);
    expect(breakers).toBeGreaterThanOrEqual(fetches);
  });
});
