/**
 * Node test fixtures — "test-as-data" per i custom node author.
 *
 * Un fixture descrive UN caso di test del nodo come DATI (non codice): dato
 * `config` + `input`, l'azione deve produrre `expect.output` (deep-equal) oppure
 * fallire con un messaggio che contiene `expect.errorMatch`. I fixture vivono in
 * file `*.fixture.json` / `*.fixture.ts` accanto al nodo e sono eseguibili da CLI
 * (`ffnode-test`) → integrabili in CI senza scrivere un test runner a mano.
 */
import type { CommunityNodeDefinition, ExecutionContext } from './index.js';

export interface NodeFixture {
  /** Nome leggibile del caso (mostrato nel report). */
  name: string;
  /** Id dell'azione da eseguire. Default: la prima azione del nodo. */
  action?: string;
  /** Config del nodo per questo caso. */
  config?: Record<string, unknown>;
  /** Input passato all'azione. */
  input?: unknown;
  /** Override parziali del contesto di esecuzione (tenantId, runId, …). */
  context?: Partial<ExecutionContext>;
  /** Aspettativa: output esatto (deep-equal) OPPURE un errore atteso. */
  expect: { output: unknown } | { errorMatch: string };
}

export interface FixtureResult {
  name: string;
  passed: boolean;
  /** Spiegazione del fallimento (vuoto se passed). */
  detail: string;
}

export interface FixtureSummary {
  total: number;
  passed: number;
  failed: number;
  results: FixtureResult[];
}

/** Deep structural equality (stabile rispetto all'ordine delle chiavi). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

function defaultContext(over?: Partial<ExecutionContext>): ExecutionContext {
  return {
    tenantId: over?.tenantId ?? 'fixture-tenant',
    runId: over?.runId ?? 'fixture-run',
    workflowId: over?.workflowId ?? 'fixture-wf',
    nodeId: over?.nodeId ?? 'fixture-node',
    ...(over?.action !== undefined ? { action: over.action } : {}),
  };
}

/** Esegue un singolo fixture contro il nodo, ritornando l'esito. */
export async function runNodeFixture(spec: CommunityNodeDefinition, fx: NodeFixture): Promise<FixtureResult> {
  const action = fx.action
    ? spec.actions.find((a) => a.id === fx.action)
    : spec.actions[0];
  if (!action) {
    return { name: fx.name, passed: false, detail: `azione "${fx.action ?? '(prima)'}" non trovata nel nodo` };
  }
  const ctx = defaultContext({ ...fx.context, action: action.id });
  const expectError = 'errorMatch' in fx.expect ? fx.expect.errorMatch : null;
  try {
    const output = await action.execute(fx.config ?? {}, fx.input, ctx);
    if (expectError !== null) {
      return { name: fx.name, passed: false, detail: `atteso errore contenente "${expectError}", ma l'azione è riuscita` };
    }
    const expected = (fx.expect as { output: unknown }).output;
    if (deepEqual(output, expected)) return { name: fx.name, passed: true, detail: '' };
    return {
      name: fx.name, passed: false,
      detail: `output diverso dall'atteso.\n  atteso:   ${JSON.stringify(expected)}\n  ricevuto: ${JSON.stringify(output)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (expectError !== null) {
      return expectError === '' || message.includes(expectError)
        ? { name: fx.name, passed: true, detail: '' }
        : { name: fx.name, passed: false, detail: `errore "${message}" non contiene "${expectError}"` };
    }
    return { name: fx.name, passed: false, detail: `errore inatteso: ${message}` };
  }
}

/** Esegue tutti i fixture e produce un sommario aggregato. */
export async function runNodeFixtures(spec: CommunityNodeDefinition, fixtures: readonly NodeFixture[]): Promise<FixtureSummary> {
  const results: FixtureResult[] = [];
  for (const fx of fixtures) {
    results.push(await runNodeFixture(spec, fx));
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}
