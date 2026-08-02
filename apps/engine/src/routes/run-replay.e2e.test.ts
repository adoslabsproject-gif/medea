/**
 * E2E FULL-REQUEST-PATH — replay parziale GAP 4 (punto (d) del piano).
 *
 * ZERO MOCK: HTTP POST → route run-replay REALE → RunService REALE →
 * WorkflowEngine REALE → executor stdlib REALI → SQLite REALE (worker db del
 * vitest.setup). La run storica è seminata ESEGUENDO davvero il workflow.
 *
 * La prova di "non ri-eseguito" è un SIDE-EFFECT fisico: ogni nodo è un
 * action_file_write in append — se il file del nodo a monte ha ancora UNA
 * riga dopo il replay, quell'executor non è girato. Niente spy, niente
 * coverage green-confirming: o i byte sono sul disco o non lo sono.
 *
 * Classe di bug bersaglio (lezione dashboard 2026-06-11): "riga coperta ≠
 * scope giusto" — i layer testati separatamente possono mentire sul glue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRunReplayRoutes } from './run-replay.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { runMigrations } from '@/storage/migrate.js';
import { ensureCredentialsTable } from '@/services/credentials.service.js';

let root = '';
let savedDataDir: string | undefined;
let app: Hono;
let wfId = '';
let seedRunId = '';
let tenantFiles = '';

const bus = new InMemoryEventBus();
const workflows = new WorkflowService(bus);
const runService = new RunService(bus);

/** Righe non vuote di un log nel sandbox tenant ('' se il file non esiste). */
async function logLines(name: string): Promise<number> {
  try {
    const txt = await readFile(join(tenantFiles, name), 'utf8');
    return txt.split('\n').filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

async function replayHttp(qs: string, body?: unknown): Promise<Response> {
  return app.request(`/api/v1/workflows/${wfId}/runs/${seedRunId}/replay${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  // Schema COMPLETO (incluse le tabelle lazy come `tenants` usata dalla quota
  // di WorkflowService.create) — qui nessun modulo è mockato, quindi è sicuro.
  runMigrations();
  // L'engine REALE risolve i provider LLM per nodo → query su user_credentials
  // (lazy-create del bootstrap server). Stesso ensure della produzione.
  ensureCredentialsTable();
  root = await mkdtemp(join(tmpdir(), 'ffreplay-e2e-'));
  savedDataDir = process.env.MEDEA_DATA_DIR;
  process.env.MEDEA_DATA_DIR = root;
  tenantFiles = join(root, 'tenants', 'default', 'files');

  // App HTTP con auth context reale-minimale (come lo monta il middleware JWT).
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, { tenantId: 'default', userId: 'u-e2e', role: 'admin' } as never);
    await next();
  });
  app.route('/api/v1', createRunReplayRoutes(bus));

  // Workflow REALE persistito: n1 → n2 → n3, ogni nodo appende UNA riga
  // al proprio log (side-effect fisico osservabile).
  // Il newline nel content è il METRO DI MISURA: append senza newline produce
  // 'n2-runn2-run' = 1 sola "riga" e il conteggio mente (bug catturato in
  // prima stesura di QUESTO test — la misura era rotta, non il sistema).
  const fw = (n: string) => ({
    id: n,
    defId: 'action_file_write',
    x: 0,
    y: 0,
    config: { path: `${n}.log`, content: `${n}-run\n`, mode: 'append' },
  });
  const wf = await workflows.create({
    name: 'replay-e2e',
    enabled: true,
    tenantId: 'default',
    nodes: [fw('n1'), fw('n2'), fw('n3')],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  });
  wfId = wf.id;

  // Semina la run storica ESEGUENDO davvero (RunService reale → engine reale).
  const seeded = await runService.execute({
    workflowId: wfId,
    tenantId: 'default',
    triggerInput: { seed: true },
  });
  seedRunId = seeded.runId;
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.MEDEA_DATA_DIR;
  else process.env.MEDEA_DATA_DIR = savedDataDir;
});

describe('🚨🚨 E2E full-request-path — replay parziale attraverso TUTTO lo stack reale', () => {
  it('🚨 seed: la run storica ha scritto 1 riga per nodo (baseline fisica)', async () => {
    expect(await logLines('n1.log')).toBe(1);
    expect(await logLines('n2.log')).toBe(1);
    expect(await logLines('n3.log')).toBe(1);
  });

  it('🚨 "solo questo nodo" (fromNode=n2&toNode=n2) + pin-edit: n2 RI-SCRIVE, n1 e n3 NO, override nel carriedInput', async () => {
    const res = await replayHttp('?fromNode=n2&toNode=n2', {
      pinnedOverrides: { n1: { tag: 'EDITED-BY-USER' } },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      run: { status: string; steps: { nodeId: string; input?: string }[] };
      pinnedCount: number;
      overriddenCount: number;
      stoppedAfterNode?: string;
    };
    expect(json.run.status).toBe('success');
    expect(json.stoppedAfterNode).toBe('n2');
    expect(json.pinnedCount).toBe(1); // n1 (storico, poi sovrascritto dall'edit)
    expect(json.overriddenCount).toBe(1);

    // PROVA FISICA: solo n2 è girato davvero.
    expect(await logLines('n1.log')).toBe(1); // NON ri-eseguito (pinnato)
    expect(await logLines('n2.log')).toBe(2); // RI-eseguito
    expect(await logLines('n3.log')).toBe(1); // MAI raggiunto (toNode stop)

    // L'edit dell'utente è arrivato fino all'ENGINE: l'input di n2 è l'override.
    const stepN2 = json.run.steps.find((s) => s.nodeId === 'n2');
    expect(stepN2?.input).toContain('EDITED-BY-USER');
  });

  it('🚨 "esegui da qui" (fromNode=n2, senza toNode): n2 e n3 ri-scrivono, n1 resta pinnato', async () => {
    const res = await replayHttp('?fromNode=n2');
    expect(res.status).toBe(200);
    expect(await logLines('n1.log')).toBe(1); // ancora 1: mai ri-eseguito
    expect(await logLines('n2.log')).toBe(3); // 2ª ri-esecuzione
    expect(await logLines('n3.log')).toBe(2); // la valle ORA gira (no toNode)
  });

  it('🚨 fromNode fantasma → 400 dal full stack, NESSUN side-effect su disco', async () => {
    const before = [await logLines('n1.log'), await logLines('n2.log'), await logLines('n3.log')];
    const res = await replayHttp('?fromNode=ghost-node');
    expect(res.status).toBe(400);
    const after = [await logLines('n1.log'), await logLines('n2.log'), await logLines('n3.log')];
    expect(after).toEqual(before); // il filesystem non si è mosso
  });

  it('🚨 il replay è una RUN PERSISTITA reale (status success in tabella runs)', async () => {
    const res = await replayHttp('?fromNode=n3&toNode=n3');
    const json = (await res.json()) as { run: { runId: string } };
    // riusa la stessa surface reale: la lista run del workflow contiene il replay
    const list = (await runService.list(wfId, 'default')) as {
      id: string;
      status: string;
      triggerType?: string;
    }[];
    const replayRow = list.find((r) => r.id === json.run.runId);
    expect(replayRow).toBeDefined();
    expect(replayRow!.status).toBe('success');
  });
});
