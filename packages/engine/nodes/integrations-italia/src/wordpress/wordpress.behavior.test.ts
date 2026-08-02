/**
 * Behavior + guard test — italia_wordpress (review nodi 2026-06-20).
 *
 * Due fix verificati QUI (non solo contract statico):
 *  1. INPUT ROTTO: il campo JSON utente (data) dava un `SyntaxError` opaco di
 *     `JSON.parse`. Ora errore PULITO che nomina il campo (scatta prima della rete).
 *  2. POOL: ogni fetch passa per `executeWithHostBreaker` (come fic/register-it).
 *     Guard sorgente anti-regressione: nessun `await safeFetchWithRedirects` nudo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { NodeExecutionContext } from '@medea/engine-nodes-stdlib';
import { wordpressNode } from './index.js';

function ctx(): NodeExecutionContext {
  return { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };
}

const creds = { baseUrl: 'https://wp.example', username: 'admin', appPassword: 'abcd efgh ijkl mnop' };
const run = wordpressNode.executor!;

describe('italia_wordpress — behavior (input rotto)', () => {
  it('🚨 create con data JSON malformato → errore PULITO che nomina il campo', async () => {
    await expect(
      run({ ...creds, action: 'create', resource: 'posts', data: '{bad json' }, undefined, ctx()),
    ).rejects.toThrow(/il campo "data" non è JSON valido/);
  });

  it('🚨 update con data JSON malformato → errore PULITO (scatta prima della rete)', async () => {
    await expect(
      run({ ...creds, action: 'update', resource: 'posts', id: '7', data: 'NOPE' }, undefined, ctx()),
    ).rejects.toThrow(/il campo "data" non è JSON valido/);
  });

  it('credenziali validate PRIMA del parse (appPassword assente)', async () => {
    await expect(
      run({ baseUrl: 'https://wp.example', username: 'a', action: 'create', resource: 'posts', data: '{bad' }, undefined, ctx()),
    ).rejects.toThrow(/baseUrl \+ username \+ appPassword/);
  });

  it('resource=custom senza customPath → errore chiaro (no fetch)', async () => {
    await expect(
      run({ ...creds, action: 'list', resource: 'custom' }, undefined, ctx()),
    ).rejects.toThrow(/customPath richiesto/);
  });
});

describe('italia_wordpress — guard sorgente (circuit breaker)', () => {
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
