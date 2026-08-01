/**
 * Tests per `subworkflowExecutor` — N17 audit (anti-recursion-bomb).
 *
 * Coperture:
 *  1. Self-recursion: workflowId == context.workflowId → throw
 *  2. Depth cap: depth >= MAX_SUBWORKFLOW_DEPTH → throw
 *  3. Boundary: depth = MAX-1 (last allowed level) → fetch chiamata
 *  4. Propagation: X-Subworkflow-Depth header impostato a depth + 1
 *  5. Init: depth assente nel context → trattato come 0
 *  6. Source inspection: cap, header name, env override
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { subworkflowNode } from './subworkflow.js';
import type { NodeExecutionContext } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const subworkflowSource = readFileSync(join(__dirname, 'subworkflow.ts'), 'utf-8');

function makeContext(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    tenantId: 't1',
    workflowId: 'wf-parent',
    runId: 'run-1',
    nodeId: 'node-1',
    secrets: {},
    ...overrides,
  };
}

describe('N17 — subworkflow source inspection (anti-recursion-bomb guards)', () => {
  it('MAX_SUBWORKFLOW_DEPTH costante dichiarata', () => {
    expect(subworkflowSource).toMatch(/MAX_SUBWORKFLOW_DEPTH/);
  });

  it('env override FLOWFORGE_MAX_SUBWORKFLOW_DEPTH presente', () => {
    expect(subworkflowSource).toMatch(/FLOWFORGE_MAX_SUBWORKFLOW_DEPTH/);
  });

  it('default cap = 10', () => {
    // Accetta sia bracket-notation `env['…']` sia dot-notation `env.…`
    // (eslint --fix dot-notation può normalizzare l'una nell'altra) e la forma
    // ISOMORFICA `(typeof process … ? process.env.X : undefined) ?? 10` (guard
    // anti "process is not defined" nel bundle browser dell'editor). In tutte
    // il default resta 10.
    expect(subworkflowSource).toMatch(/FLOWFORGE_MAX_SUBWORKFLOW_DEPTH(?:'])?(?:\s*:\s*undefined\s*\))?\s*\?\?\s*10/);
  });

  it('self-recursion guard PRECEDE qualsiasi fetch', () => {
    const selfCheckIdx = subworkflowSource.indexOf('workflowId === context.workflowId');
    const fetchIdx = subworkflowSource.indexOf('await fetch(');
    expect(selfCheckIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeGreaterThan(0);
    expect(selfCheckIdx).toBeLessThan(fetchIdx);
  });

  it('depth cap check PRECEDE fetch', () => {
    const depthCheckIdx = subworkflowSource.indexOf('depth >= MAX_SUBWORKFLOW_DEPTH');
    const fetchIdx = subworkflowSource.indexOf('await fetch(');
    expect(depthCheckIdx).toBeGreaterThan(0);
    expect(depthCheckIdx).toBeLessThan(fetchIdx);
  });

  it('header X-Subworkflow-Depth: depth + 1 propagato', () => {
    expect(subworkflowSource).toMatch(/'X-Subworkflow-Depth':\s*String\(depth\s*\+\s*1\)/);
  });

  it('depth letto da context.subworkflowDepth', () => {
    expect(subworkflowSource).toMatch(/context\.subworkflowDepth/);
  });

  it('SECURITY: validazione formato workflowId PRECEDE qualsiasi fetch', () => {
    const validIdx = subworkflowSource.indexOf('workflowId non valido');
    const fetchIdx = subworkflowSource.indexOf('await fetch(');
    expect(validIdx).toBeGreaterThan(0);
    expect(validIdx).toBeLessThan(fetchIdx);
  });

  it('SECURITY: l\'URL usa encodeURIComponent(workflowId) (difesa-in-profondità)', () => {
    expect(subworkflowSource).toMatch(/workflows\/\$\{encodeURIComponent\(workflowId\)\}\/run/);
  });
});

describe('N17 — subworkflowExecutor behavioural', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    // Una Response NUOVA a ogni chiamata: da quando `wait` aspetta davvero,
    // l'esecutore interroga `GET /runs/:id` dopo il `POST /run`, e riusare la
    // stessa istanza darebbe «ReadableStream is locked» — un fallimento del
    // finto, non del codice.
    fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ run: { runId: 'r-child', status: 'success', steps: [], totalDurationMs: 5 } }),
          { status: 200 },
        ),
      ),
    );
    // @ts-expect-error vitest mock
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.FLOWFORGE_MAX_SUBWORKFLOW_DEPTH;
  });

  it('missing workflowId → throw "missing workflowId"', async () => {
    await expect(
      subworkflowNode.executor!({}, null, makeContext()),
    ).rejects.toThrow(/missing workflowId/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SECURITY: self-recursion (same id as caller) → throw, no fetch', async () => {
    await expect(
      subworkflowNode.executor!({ workflowId: 'wf-parent' }, null, makeContext({ workflowId: 'wf-parent' })),
    ).rejects.toThrow(/self-recursion not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SECURITY: depth >= MAX (default 10) → throw, no fetch', async () => {
    await expect(
      subworkflowNode.executor!(
        { workflowId: 'wf-child' },
        null,
        makeContext({ subworkflowDepth: 10 }),
      ),
    ).rejects.toThrow(/max recursion depth 10 exceeded/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['path traversal verso API interna', '../internal/egress-allowlist'],
    ['slash (sub-path)', 'wf/run'],
    ['query string', 'wf?admin=1'],
    ['fragment', 'wf#x'],
    ['percent-encoded dot', 'wf%2e%2e'],
    ['spazio', 'wf child'],
    ['troppo lungo (>128)', 'a'.repeat(129)],
  ])('SECURITY path-injection: workflowId con %s → throw, NESSUN fetch', async (_label, badId) => {
    // MUTATION: senza la regex allowlist questi id raggiungerebbero il fetch verso
    // l'API interna con X-Internal-Token (privilege escalation) → test rosso.
    await expect(
      subworkflowNode.executor!({ workflowId: badId }, null, makeContext()),
    ).rejects.toThrow(/workflowId non valido/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('workflowId valido (nanoid/UUID) → fetch chiamato sull\'URL atteso', async () => {
    await subworkflowNode.executor!({ workflowId: 'wf-child_AbZ09-1' }, null, makeContext());
    // La PRIMA chiamata è il dispatch. Da quando `wait` aspetta davvero ne
    // segue almeno un'altra su `/runs/:id`: fissare il conteggio a uno
    // significherebbe pretendere che l'attesa non ci sia.
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toBe('http://127.0.0.1:3100/api/v1/workflows/wf-child_AbZ09-1/run');
    expect(calledUrl).not.toContain('..');
  });

  it('SECURITY: depth > MAX (15) → throw', async () => {
    await expect(
      subworkflowNode.executor!(
        { workflowId: 'wf-child' },
        null,
        makeContext({ subworkflowDepth: 15 }),
      ),
    ).rejects.toThrow(/max recursion depth 10 exceeded/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('BOUNDARY: depth = MAX - 1 (9, last allowed) → fetch chiamata', async () => {
    await subworkflowNode.executor!(
      { workflowId: 'wf-child' },
      null,
      makeContext({ subworkflowDepth: 9 }),
    );
    // Basta che il dispatch sia partito: l'ultimo livello consentito è
    // consentito. Il numero di chiamate dipende dall'attesa, non dal cap.
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/workflows/wf-child/run');
  });

  it('PROPAGATION: header X-Subworkflow-Depth: 1 quando depth=0 (default init)', async () => {
    await subworkflowNode.executor!({ workflowId: 'wf-child' }, null, makeContext());
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Subworkflow-Depth']).toBe('1');
  });

  it('PROPAGATION: header X-Subworkflow-Depth: 6 quando depth=5', async () => {
    await subworkflowNode.executor!(
      { workflowId: 'wf-child' },
      null,
      makeContext({ subworkflowDepth: 5 }),
    );
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Subworkflow-Depth']).toBe('6');
  });

  it('depth assente nel context → trattata come 0', async () => {
    await subworkflowNode.executor!(
      { workflowId: 'wf-child' },
      null,
      makeContext({ subworkflowDepth: undefined }),
    );
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Subworkflow-Depth']).toBe('1');
  });

  it('header X-Tenant-Id preservato (no regressione)', async () => {
    await subworkflowNode.executor!(
      { workflowId: 'wf-child' },
      null,
      makeContext({ tenantId: 'tenant-xyz' }),
    );
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Tenant-Id']).toBe('tenant-xyz');
  });

  it('REGRESSION: A→A diretto (self) bloccato anche con depth=0', async () => {
    await expect(
      subworkflowNode.executor!(
        { workflowId: 'wf-A' },
        null,
        makeContext({ workflowId: 'wf-A', subworkflowDepth: 0 }),
      ),
    ).rejects.toThrow(/self-recursion/);
  });

  it('REGRESSION: A→A diretto bloccato anche a depth=9 (priorita` self check)', async () => {
    await expect(
      subworkflowNode.executor!(
        { workflowId: 'wf-A' },
        null,
        makeContext({ workflowId: 'wf-A', subworkflowDepth: 9 }),
      ),
    ).rejects.toThrow(/self-recursion/);
  });
});

/**
 * Da quando `wait` aspetta davvero.
 *
 * La descrizione del nodo prometteva «await fino al completamento del sub»,
 * ma l'esecutore restituiva la risposta 202 del dispatch: il parent riceveva
 * `status: running` e zero step. Questi test fissano il comportamento
 * corretto, e quello che succede quando il sub non finisce.
 */
describe('subworkflow — attesa del completamento', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.FLOWFORGE_SUBWORKFLOW_WAIT_TIMEOUT_MS;
  });

  /** Un finto che risponde al dispatch e poi agli stati che gli si danno. */
  function fintoRuntime(stati: string[]): ReturnType<typeof vi.fn> {
    let letture = 0;
    return vi.fn().mockImplementation((url: string) => {
      // `/runs/<id>` contiene `/run`: distinguere male fa credere al finto
      // che ogni interrogazione sia un dispatch, e l'attesa non finisce mai.
      const isDispatch = url.endsWith('/run');
      const status = isDispatch ? 'running' : (stati[Math.min(letture++, stati.length - 1)] ?? 'success');
      return Promise.resolve(
        new Response(
          JSON.stringify({ run: { runId: 'r-child', status, steps: [{ nodeId: 'x' }], totalDurationMs: 12 } }),
          { status: 200 },
        ),
      );
    });
  }

  it('con wait, restituisce lo stato TERMINALE, non quello appena partito', async () => {
    const spy = fintoRuntime(['running', 'running', 'success']);
    // @ts-expect-error vitest mock
    globalThis.fetch = spy;

    const res = await subworkflowNode.executor!(
      { workflowId: 'wf-child', wait: 'true' },
      null,
      makeContext(),
    );

    expect((res.output as { status: string }).status).toBe('success');
    expect((res.output as { steps: unknown[] }).steps).toHaveLength(1);
  });

  it('interroga finché non ha finito, invece di fermarsi alla prima risposta', async () => {
    const spy = fintoRuntime(['running', 'success']);
    // @ts-expect-error vitest mock
    globalThis.fetch = spy;

    await subworkflowNode.executor!({ workflowId: 'wf-child', wait: 'true' }, null, makeContext());

    // Il dispatch più almeno due letture: se si fermasse alla prima, il
    // parent riceverebbe di nuovo un'esecuzione appena nata.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('un errore del sub arriva al parent come stato, non come eccezione', async () => {
    // Sta al parent decidere: c'è `continueOnFail` per quello.
    const spy = fintoRuntime(['error']);
    // @ts-expect-error vitest mock
    globalThis.fetch = spy;

    const res = await subworkflowNode.executor!(
      { workflowId: 'wf-child', wait: 'true' },
      null,
      makeContext(),
    );
    expect((res.output as { status: string }).status).toBe('error');
  });

  it('senza wait non aspetta niente: una chiamata sola', async () => {
    const spy = fintoRuntime(['success']);
    // @ts-expect-error vitest mock
    globalThis.fetch = spy;

    const res = await subworkflowNode.executor!(
      { workflowId: 'wf-child', wait: 'false' },
      null,
      makeContext(),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect((res.output as { started: boolean }).started).toBe(true);
  });

  it('se il sub non finisce entro il tetto, fallisce dicendolo', async () => {
    // Restituire un risultato che non c'è sarebbe peggio: chi vuole
    // proseguire lo stesso ha `continueOnFail`.
    process.env.FLOWFORGE_SUBWORKFLOW_WAIT_TIMEOUT_MS = '300';
    const spy = fintoRuntime(['running']);
    // @ts-expect-error vitest mock
    globalThis.fetch = spy;

    await expect(
      subworkflowNode.executor!({ workflowId: 'wf-child', wait: 'true' }, null, makeContext()),
    ).rejects.toThrow(/non ha finito entro/);
  });
});
