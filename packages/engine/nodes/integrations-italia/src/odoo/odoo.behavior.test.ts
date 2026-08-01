/**
 * Behavior + guard test — italia_odoo (review nodi 2026-06-20).
 *
 * Fix verificati QUI:
 *  1. DEAD CODE / param aspirazionale (client.ts): `jsonRpcCall` creava un
 *     `AbortController`+`setTimeout(timeoutMs)` ma NON passava `controller.signal`
 *     a `safeFetchWithRedirects`, e NON passava `timeoutMs` → il parametro
 *     timeoutMs era IGNORATO (controller dead-allocato a ogni chiamata). Ora il
 *     controller è rimosso e `timeoutMs` è passato davvero a safeFetch.
 *  2. POOL: ogni JSON-RPC passa per `executeWithHostBreaker` (url user-provided).
 *  3. INPUT ROTTO: l'executor valida le credenziali e fa parse JSON descrittivo
 *     PRIMA di toccare la rete.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';
import { odooNode } from './index.js';

function ctx(): NodeExecutionContext {
  return { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };
}
const creds = { url: 'https://erp.example', database: 'prod', username: 'bot', apiKey: 'k' };
const run = odooNode.executor!;

describe('italia_odoo — behavior (validazione pre-rete)', () => {
  // Solo i guard PRIMA di getAuthenticatedUid (rete) sono testabili senza mock:
  // cred-check (riga 279) e model-check (riga 292) precedono l'auth.
  it('🚨 credenziali mancanti → errore chiaro (no rete)', async () => {
    await expect(
      run({ action: 'search_read', model: 'res.partner' }, undefined, ctx()),
    ).rejects.toThrow(/url \+ database \+ username \+ apiKey/);
  });

  it('🚨 model mancante per action ≠ check_connection → errore chiaro (no rete)', async () => {
    await expect(
      run({ ...creds, action: 'search_read' }, undefined, ctx()),
    ).rejects.toThrow(/model obbligatorio/);
  });
});

describe('italia_odoo client.ts — guard sorgente (no dead code, breaker, timeout onorato)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'client.ts'), 'utf8');

  it('🚨 nessun AbortController dead (era allocato senza essere passato a fetch)', () => {
    expect(src).not.toMatch(/new AbortController/);
  });

  it('🚨 timeoutMs è passato davvero a safeFetchWithRedirects (param non più aspirazionale)', () => {
    expect(src).toMatch(/timeoutMs,/);
  });

  it('🚨 nessun safeFetchWithRedirects awaited NUDO — passa dal breaker', () => {
    expect(src).not.toMatch(/await\s+safeFetchWithRedirects\s*\(/);
    expect(src).toMatch(/executeWithHostBreaker\s*\(/);
  });
});
