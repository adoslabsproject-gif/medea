/**
 * AiExplainService — integration tests with a mocked LLM dispatcher.
 *
 * We don't call out to a real LLM in tests (latency + flakiness + cost),
 * but we DO exercise the full pipeline: load run → build prompt → invoke
 * dispatcher → parse JSON → validate → log interaction.
 *
 * Setup mirrors the AIInteractionsService test pattern: per-test fresh
 * SQLite, migrations applied, seeded with the rows the service expects to
 * read (workflows + runs).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  AiExplainService,
  type LlmDispatcher,
  RunNotFoundError,
  RunSucceededError,
  NoFailedStepError,
  LlmResponseError,
} from './ai-explain.service.js';
import { closeDatabase, getDatabase } from '@/storage/db.js';
import { runMigrations } from '@/storage/migrate.js';
import { resetConfigForTests } from '@/config.js';
import { LlmProvidersService } from './llm-providers.service.js';
import { ensureCredentialsTable } from './credentials.service.js';
import { AIInteractionsService } from './ai-interactions.service.js';

let tmpDir: string;
let originalDbPath: string | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ff-aiexp-'));
  originalDbPath = process.env.MEDEA_DB_PATH;
  process.env.MEDEA_DB_PATH = join(tmpDir, 'test.sqlite');
  process.env.MEDEA_DATA_DIR = tmpDir;
  // Setup an Anthropic key so the resolver doesn't fall back to Liara/error
  process.env.MEDEA_MASTER_PASSWORD = 'test-master-password-32-chars-min';
  resetConfigForTests();
  await closeDatabase();
  runMigrations();
  ensureCredentialsTable();
  // Track B opt-in (default OFF): l'explain cattura l'interazione solo se il
  // tenant ha acconsentito → qui abilitiamo 'acme' per testarne la cattura.
  new AIInteractionsService().setCapturePreference('acme', true);
  // Provision a fake Anthropic API key for the tenant 'acme' so llmResolver
  // returns provider=anthropic. The mocked dispatcher will ignore the value.
  void new LlmProvidersService().upsert('acme', 'anthropic', { apiKey: 'sk-ant-test-key' });
});

afterEach(async () => {
  await closeDatabase();
  if (originalDbPath !== undefined) process.env.MEDEA_DB_PATH = originalDbPath;
  else delete process.env.MEDEA_DB_PATH;
  resetConfigForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Fixtures ────────────────────────────────────────────────────────── */

function seedWorkflow(id: string, tenant = 'acme'): void {
  const { sqlite } = getDatabase();
  const nodes = [
    { id: 'n-trigger', defId: 'trigger_manual' },
    { id: 'n-mail', defId: 'action_send_email', config: { to: 'x@y.it', subject: 'S', body: 'B' } },
  ];
  const edges = [{ id: 'e1', from: 'n-trigger', to: 'n-mail' }];
  sqlite
    .prepare(
      `
      INSERT INTO workflows (id, tenant_id, name, enabled, nodes_json, edges_json, node_defs_json, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, '[]', datetime('now'), datetime('now'))
    `,
    )
    .run(id, tenant, 'Test WF', JSON.stringify(nodes), JSON.stringify(edges));
}

function seedRun(args: {
  runId?: string;
  tenant?: string;
  workflowId: string;
  status: 'success' | 'error' | 'partial';
  failedStep?: { nodeId: string; defId: string; error: string };
}): string {
  const { sqlite } = getDatabase();
  const id = args.runId ?? randomUUID();
  const steps = args.failedStep
    ? [
        {
          nodeId: 'n-trigger',
          defId: 'trigger_manual',
          status: 'success',
          output: 'ok',
          durationMs: 1,
        },
        {
          nodeId: args.failedStep.nodeId,
          defId: args.failedStep.defId,
          status: 'error',
          error: args.failedStep.error,
          durationMs: 472,
        },
      ]
    : [{ nodeId: 'n-trigger', defId: 'trigger_manual', status: 'success', durationMs: 1 }];

  sqlite
    .prepare(
      `
      INSERT INTO runs (id, workflow_id, tenant_id, status, trigger_type, input, error_count, total_duration_ms, started_at, ended_at, steps_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
    `,
    )
    .run(
      id,
      args.workflowId,
      args.tenant ?? 'acme',
      args.status,
      'manual',
      JSON.stringify({ key: 'value' }),
      args.failedStep ? 1 : 0,
      500,
      JSON.stringify(steps),
    );
  return id;
}

/* ── Tests ───────────────────────────────────────────────────────────── */

describe('AiExplainService', () => {
  describe('error cases', () => {
    it('throws RunNotFoundError when the run id is unknown', async () => {
      const svc = new AiExplainService(vi.fn() as unknown as LlmDispatcher);
      await expect(svc.explain({ tenantId: 'acme', runId: 'nonexistent' })).rejects.toBeInstanceOf(
        RunNotFoundError,
      );
    });

    it('throws RunSucceededError when the run status is success', async () => {
      const dispatch = vi.fn();
      const svc = new AiExplainService(dispatch as unknown as LlmDispatcher);
      const wfId = 'wf1';
      seedWorkflow(wfId);
      const runId = seedRun({ workflowId: wfId, status: 'success' });
      await expect(svc.explain({ tenantId: 'acme', runId })).rejects.toBeInstanceOf(
        RunSucceededError,
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('throws NoFailedStepError when status != success but no error step', async () => {
      const svc = new AiExplainService(vi.fn() as unknown as LlmDispatcher);
      const wfId = 'wf2';
      seedWorkflow(wfId);
      const runId = seedRun({ workflowId: wfId, status: 'error' }); // no failedStep arg → all OK
      await expect(svc.explain({ tenantId: 'acme', runId })).rejects.toBeInstanceOf(
        NoFailedStepError,
      );
    });

    it('throws LlmResponseError when LLM returns non-JSON', async () => {
      const dispatch: LlmDispatcher = async () => 'this is plain text, not JSON';
      const svc = new AiExplainService(dispatch);
      const wfId = 'wf3';
      seedWorkflow(wfId);
      const runId = seedRun({
        workflowId: wfId,
        status: 'partial',
        failedStep: { nodeId: 'n-mail', defId: 'action_send_email', error: 'SMTP 550' },
      });
      await expect(svc.explain({ tenantId: 'acme', runId })).rejects.toBeInstanceOf(
        LlmResponseError,
      );
    });

    it('throws LlmResponseError when LLM returns JSON with wrong shape', async () => {
      const dispatch: LlmDispatcher = async () => JSON.stringify({ banana: 'no schema match' });
      const svc = new AiExplainService(dispatch);
      const wfId = 'wf4';
      seedWorkflow(wfId);
      const runId = seedRun({
        workflowId: wfId,
        status: 'error',
        failedStep: { nodeId: 'n-mail', defId: 'action_send_email', error: 'X' },
      });
      await expect(svc.explain({ tenantId: 'acme', runId })).rejects.toBeInstanceOf(
        LlmResponseError,
      );
    });
  });

  describe('happy path', () => {
    it('returns explanation + fix + patch + interactionId on a partial run', async () => {
      const dispatch: LlmDispatcher = async () =>
        JSON.stringify({
          explanation: 'Il server SMTP ha rifiutato la mail perché il mittente non è autorizzato.',
          fix: 'Imposta il campo "From" uguale all\'username SMTP configurato.',
          patch: {
            updateNodes: [{ id: 'n-mail', patch: { config: { from: 'noreply@dominio.it' } } }],
          },
        });
      const svc = new AiExplainService(dispatch);
      const wfId = 'wf5';
      seedWorkflow(wfId);
      const runId = seedRun({
        workflowId: wfId,
        status: 'partial',
        failedStep: {
          nodeId: 'n-mail',
          defId: 'action_send_email',
          error: '550 Sender not allowed',
        },
      });

      const result = await svc.explain({ tenantId: 'acme', runId, userId: 'admin' });
      expect(result.runId).toBe(runId);
      expect(result.failedNodeId).toBe('n-mail');
      expect(result.explanation).toContain('SMTP');
      expect(result.fix).toContain('From');
      expect(result.patch).toBeDefined();
      expect(result.interactionId).not.toBeNull();
    });

    it('omits patch when LLM responds without one (e.g. "needs manual setup")', async () => {
      const dispatch: LlmDispatcher = async () =>
        JSON.stringify({
          explanation: 'Devi configurare la API key in Settings.',
          fix: 'Vai in Settings → AI Providers e aggiungi la key Anthropic.',
        });
      const svc = new AiExplainService(dispatch);
      const wfId = 'wf6';
      seedWorkflow(wfId);
      const runId = seedRun({
        workflowId: wfId,
        status: 'error',
        failedStep: { nodeId: 'n-mail', defId: 'action_send_email', error: '401 Unauthorized' },
      });
      const result = await svc.explain({ tenantId: 'acme', runId });
      expect(result.patch).toBeUndefined();
      expect(result.interactionId).not.toBeNull();
    });

    it('strips ```json fences from the LLM response before parsing', async () => {
      const dispatch: LlmDispatcher = async () => '```json\n{"explanation":"x","fix":"y"}\n```';
      const svc = new AiExplainService(dispatch);
      const wfId = 'wf7';
      seedWorkflow(wfId);
      const runId = seedRun({
        workflowId: wfId,
        status: 'partial',
        failedStep: { nodeId: 'n-mail', defId: 'action_send_email', error: 'X' },
      });
      const result = await svc.explain({ tenantId: 'acme', runId });
      expect(result.explanation).toBe('x');
      expect(result.fix).toBe('y');
    });
  });

  describe('dispatcher input', () => {
    it('passes the system prompt and workflow context to the dispatcher', async () => {
      const dispatch = vi.fn<LlmDispatcher>(async () =>
        JSON.stringify({ explanation: 'e', fix: 'f' }),
      );
      const svc = new AiExplainService(dispatch);
      const wfId = 'wf8';
      seedWorkflow(wfId);
      const runId = seedRun({
        workflowId: wfId,
        status: 'error',
        failedStep: { nodeId: 'n-mail', defId: 'action_send_email', error: 'X' },
      });

      await svc.explain({ tenantId: 'acme', runId });

      expect(dispatch).toHaveBeenCalledOnce();
      const callArgs = dispatch.mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs!.system).toContain('FlowForge senior engineer');
      expect(callArgs!.userContent).toContain('Workflow:');
      expect(callArgs!.userContent).toContain('n-mail');
      expect(callArgs!.userContent).toContain('X');
      expect(callArgs!.provider).toBe('anthropic');
    });
  });
});
