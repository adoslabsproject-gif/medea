/**
 * Tests `http_request` tool — N20 audit (LLM-driven SSRF).
 *
 * Strategia: source inspection — verifico che il tool-loop usi
 * `safeFetchWithRedirects` di `@medea/engine-safe-fetch` invece di `fetch()`
 * raw, e che gli error SSRF tornino come tool-result strutturato.
 *
 * I behavioural test del safe-fetch helper (61 case) coprono già la
 * semantica reale; qui blocchiamo solo che il wire-up sia corretto e
 * non regredisca (pattern "fix non propagato a codice cugino" — N20
 * structural notes).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frameRagSearchResponse } from './tool-loop.js';
import { RAG_CONTENT_MARKER } from '@medea/engine-rag-guard';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolLoopSource = readFileSync(join(__dirname, 'tool-loop.ts'), 'utf-8');

describe('N20 — http_request tool wires safeFetchWithRedirects', () => {
  it('importa safeFetchWithRedirects da @medea/engine-safe-fetch', () => {
    expect(toolLoopSource).toMatch(
      /import\s*\{[^}]*safeFetchWithRedirects[^}]*\}\s*from\s*['"]@medea\/engine-safe-fetch['"]/,
    );
  });

  it('importa anche SsrfBlockedError (per discriminare errori SSRF)', () => {
    expect(toolLoopSource).toMatch(/SsrfBlockedError/);
  });

  it('SECURITY: tool http_request NON usa più fetch() raw', () => {
    // Cerco esplicitamente `await fetch(url,` nel branch http_request.
    const httpRequestIdx = toolLoopSource.indexOf("if (toolName === 'http_request')");
    const nextToolIdx = toolLoopSource.indexOf("if (toolName === 'flowforge_invoke')");
    expect(httpRequestIdx).toBeGreaterThan(0);
    expect(nextToolIdx).toBeGreaterThan(httpRequestIdx);
    const httpRequestBlock = toolLoopSource.slice(httpRequestIdx, nextToolIdx);
    expect(httpRequestBlock).not.toMatch(/await fetch\(url\b/);
    // Post gap-closure resilienza: il branch http_request passa per il gateway
    // gatewayFetch (circuit breaker per-host), che a sua volta wrappa
    // safeFetchWithRedirects. La garanzia SSRF resta intatta E rafforzata dal
    // breaker. Verifico la catena COMPLETA, non un singolo livello.
    expect(httpRequestBlock).toMatch(/await gatewayFetch\(url/);
    expect(toolLoopSource).toMatch(/async function gatewayFetch[\s\S]*?safeFetchWithRedirects\(url/);
  });

  it('SECURITY: error SsrfBlockedError ritorna tool-result strutturato (no throw)', () => {
    expect(toolLoopSource).toMatch(/err instanceof SsrfBlockedError/);
    expect(toolLoopSource).toMatch(/URL blocked by SSRF guard:/);
  });

  it('REGRESSION: body capped a 16_000 char (no leak large response in LLM context)', () => {
    expect(toolLoopSource).toMatch(/text\.slice\(0,\s*16_000\)/);
  });

  it('REGRESSION: method/headers/body presi da toolInput (LLM-controlled)', () => {
    const httpReqStart = toolLoopSource.indexOf("if (toolName === 'http_request')");
    const block = toolLoopSource.slice(httpReqStart, httpReqStart + 1200);
    // Accetta sia bracket (`toolInput['method']`) sia dot (`toolInput.method`):
    // sono equivalenti, l'eslint dot-notation può convertirle. Il punto del test è
    // che i campi vengano da toolInput (LLM-controlled), non la sintassi d'accesso.
    expect(block).toMatch(/toolInput(\.|\[['"])method/u);
    expect(block).toMatch(/toolInput(\.|\[['"])url/u);
    expect(block).toMatch(/toolInput(\.|\[['"])headers/u);
    expect(block).toMatch(/toolInput(\.|\[['"])body/u);
  });

  it('SECURITY: opts passati a safeFetchWithRedirects come oggetto type-safe', () => {
    expect(toolLoopSource).toMatch(/Parameters<typeof safeFetchWithRedirects>\[1\]/);
  });
});

describe('H3 — path-injection guard su id LLM-controlled verso API interna', () => {
  // databaseId/workflowId arrivano dall'LLM e finiscono nel PATH di gatewayFetch
  // (allowDockerNet → API interna). Senza allowlist + encode, `../../internal/...`
  // colpirebbe endpoint interni col token + X-Tenant-Id.
  const ragBlock = (() => {
    const a = toolLoopSource.indexOf("if (toolName === 'rag_search')");
    const b = toolLoopSource.indexOf("if (toolName === 'flowforge_invoke')");
    return toolLoopSource.slice(a, b);
  })();
  const invokeBlock = (() => {
    const a = toolLoopSource.indexOf("if (toolName === 'flowforge_invoke')");
    return toolLoopSource.slice(a, a + 1200);
  })();

  it('rag_search: databaseId validato con SAFE_PATH_ID + encodeURIComponent nel path', () => {
    expect(ragBlock).toMatch(/SAFE_PATH_ID\.test\(databaseId\)/);
    expect(ragBlock).toMatch(/\/vector\/\$\{encodeURIComponent\(databaseId\)\}/);
  });

  it('flowforge_invoke: workflowId validato con SAFE_PATH_ID + encodeURIComponent nel path', () => {
    expect(invokeBlock).toMatch(/SAFE_PATH_ID\.test\(workflowId\)/);
    expect(invokeBlock).toMatch(/\/workflows\/\$\{encodeURIComponent\(workflowId\)\}/);
  });

  it('SAFE_PATH_ID definita e applicata (no path-segment con / .. encoded)', () => {
    expect(toolLoopSource).toMatch(/const SAFE_PATH_ID = \/\^\[A-Za-z0-9_-\]\{1,128\}\$\//);
  });
});

describe('H6 — RAG frame-close preservato + cap maxIterations', () => {
  it('🚨 #6 frameRagSearchResponse: output troncato MANTIENE il marker di chiusura', () => {
    // results enorme → JSON framed > 16000 → con lo slice grezzo il `<<<END_RAG_CONTENT>>>`
    // veniva tagliato (frame aperto = breakout). Ora è ri-appeso.
    const huge = Array.from({ length: 500 }, (_, i) => ({
      title: `t${i}`,
      content: 'x'.repeat(200),
      url: `https://e.com/${i}`,
      score: 0.9,
    }));
    const out = frameRagSearchResponse(JSON.stringify({ results: huge, count: huge.length }));
    expect(out.length).toBeLessThanOrEqual(16_000);
    expect(out.endsWith(`<<<END_${RAG_CONTENT_MARKER}>>>`)).toBe(true);
  });

  it('frameRagSearchResponse: payload piccolo → invariato (anti-regressione)', () => {
    const out = frameRagSearchResponse(JSON.stringify({ results: [{ title: 'a', content: 'short', url: 'u', score: 1 }], count: 1 }));
    expect(out).toContain(`<<<${RAG_CONTENT_MARKER}`);
    expect(out).toContain(`<<<END_${RAG_CONTENT_MARKER}>>>`);
  });

  it('🚨 #6 maxIterations ha un CAP superiore (no runaway): Math.min(.., MAX_AGENT_ITERATIONS)', () => {
    expect(toolLoopSource).toMatch(/const MAX_AGENT_ITERATIONS = \d+/);
    expect(toolLoopSource).toMatch(/Math\.min\(Math\.trunc\(rawMaxIter\), MAX_AGENT_ITERATIONS\)/);
  });

  it('behavioral: la pattern scelta RIFIUTA i payload di path-injection e accetta id legittimi', () => {
    const SAFE_PATH_ID = /^[A-Za-z0-9_-]{1,128}$/; // stessa pattern del sorgente
    // Accettati: id reali.
    expect(SAFE_PATH_ID.test('kb_prod-2026')).toBe(true);
    expect(SAFE_PATH_ID.test('wf-abc123')).toBe(true);
    // Rifiutati: ogni vettore di traversal / path / encoding.
    for (const evil of ['../../internal/admin', 'a/b', '..', 'x%2f..', 'id with space', '../', 'a'.repeat(129)]) {
      expect(SAFE_PATH_ID.test(evil)).toBe(false);
    }
  });
});
