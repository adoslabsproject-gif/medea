/**
 * Discovery tools (read-only) — l'agente li chiama per orientarsi prima di mutare.
 *
 * - listDatabasesHandler:      elenco DB connection tenant
 * - readDbSchemaHandler:       schema completo singolo DB
 * - listWorkflowsHandler:      workflow esistenti (lean: 30 più recenti)
 * - readWorkflowHandler:       full nodes + edges di un workflow
 * - listNodeCatalogHandler:    catalogo runtime (brief o detail)
 * - listEmailAccountsHandler:  account SMTP/IMAP del tenant
 * - listSecretsHandler:        nomi secret (VALORI MAI esposti)
 * - listLlmProvidersHandler:   provider LLM configurati
 * - listDraftNodesHandler:     stato draft corrente (recovery agent)
 *
 * Estratto da ai-scaffold.service.ts (refactor 2026-05-28).
 */

import { coerceString } from '@/lib/coerce.js';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';
import type { ToolResult } from '@/services/ai-scaffold/types.js';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { WorkflowService } from '@/services/workflow.service.js';
import { SystemEmailAccountsService } from '@/services/system-email-accounts.service.js';
import { CredentialsService } from '@/services/credentials.service.js';
import { LlmProvidersService } from '@/services/llm-providers.service.js';
import { tenantAiPreferences } from '@/services/tenant-ai-preferences.service.js';
import type { IEventBus } from '@/ports/event-bus.js';

const noopBus: IEventBus = {
  emit: () => undefined,
  subscribe: () => () => undefined,
  subscribeTo: () => () => undefined,
};

export function listDatabasesHandler(session: ScaffoldSession): ToolResult {
  try {
    const dbs = session.dbStudio.list(session.tenantId);
    return {
      ok: true,
      data: dbs.map((d) => ({
        id: d.id,
        name: d.name,
        engine: d.connection?.engine ?? 'sqlite',
        tableCount: (d.tables ?? []).length,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      error: `list_databases fallito: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function readDbSchemaHandler(
  session: ScaffoldSession,
  args: Record<string, unknown>,
): ToolResult {
  const databaseId = coerceString(args.databaseId ?? '');
  const dbs = session.dbStudio.list(session.tenantId);
  const db = dbs.find((d) => d.id === databaseId);
  if (!db)
    return {
      ok: false,
      error: `Database "${databaseId}" non trovato nel tenant. DB disponibili: ${dbs.map((d) => d.id).join(', ') || '(nessuno)'}`,
    };
  return {
    ok: true,
    data: {
      id: db.id,
      name: db.name,
      tables: (db.tables ?? []).map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          primaryKey: c.constraints?.primaryKey ?? false,
          nullable: c.constraints?.nullable !== false,
        })),
      })),
    },
  };
}

export async function listWorkflowsHandler(session: ScaffoldSession): Promise<ToolResult> {
  try {
    const svc = new WorkflowService(noopBus);
    const list = await svc.list(session.tenantId);
    return {
      ok: true,
      data: list.slice(0, 30).map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? '',
        enabled: w.enabled,
        nodeCount: w.nodes.length,
        updatedAt: w.updatedAt,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      error: `list_workflows fallito: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function readWorkflowHandler(
  session: ScaffoldSession,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = coerceString(args.workflowId ?? args.id ?? '');
  if (!id) return { ok: false, error: 'read_workflow richiede workflowId.' };
  try {
    const svc = new WorkflowService(noopBus);
    const wf = await svc.get(id, session.tenantId);
    if (!wf)
      return { ok: false, error: `Workflow "${id}" non trovato (o non appartiene al tenant).` };
    return {
      ok: true,
      data: {
        id: wf.id,
        name: wf.name,
        description: wf.description,
        enabled: wf.enabled,
        nodes: wf.nodes,
        edges: wf.edges,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `read_workflow fallito: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function listNodeCatalogHandler(
  _session: ScaffoldSession,
  args: Record<string, unknown>,
): ToolResult {
  const catalog = buildNodeCatalog();
  const wantedDef = typeof args.defId === 'string' ? args.defId : '';
  if (wantedDef) {
    const entry = catalog.find((c) => c.defId === wantedDef);
    if (!entry) return { ok: false, error: `defId "${wantedDef}" non nel catalogo.` };
    return { ok: true, data: entry };
  }
  const filter = typeof args.type === 'string' ? args.type : '';
  const result = filter ? catalog.filter((c) => c.type === filter) : catalog;
  return {
    ok: true,
    data: result.map((c) => ({
      defId: c.defId,
      type: c.type,
      label: c.label,
      description: c.description,
      fieldCount: c.fields.length,
    })),
  };
}

export function listEmailAccountsHandler(session: ScaffoldSession): ToolResult {
  try {
    const svc = new SystemEmailAccountsService();
    const accounts = svc.list(session.tenantId);
    return {
      ok: true,
      data: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        fromAddress: a.fromAddress,
        imapHost: a.imap?.host ?? null,
        smtpHost: a.smtp.host,
        isDefault: a.isDefault,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      error: `list_email_accounts fallito: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function listSecretsHandler(session: ScaffoldSession): ToolResult {
  try {
    const svc = new CredentialsService();
    const list = svc.list(session.tenantId);
    // Values are NEVER returned — only names. {{ secrets.NAME }} reference convention.
    return {
      ok: true,
      data: {
        secretNames: list.map((c) => c.name),
        usage:
          "Referenzia un secret nei config con {{ secrets.NOME }} — i valori non sono mai esposti all'agente.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `list_secrets fallito: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function listLlmProvidersHandler(session: ScaffoldSession): ToolResult {
  try {
    const svc = new LlmProvidersService();
    const all = svc.list(session.tenantId);
    const configured = all.filter((p) => p.hasKey);
    // Resolve the tenant's default — used to flag `isDefault` so the agent
    // KNOWS which one to wire into every `agent_*` node without guessing.
    const defaultProvider = tenantAiPreferences.resolveDefaultProvider(
      session.tenantId,
      configured.map((p) => ({ provider: p.provider, hasKey: p.hasKey })),
    );
    return {
      ok: true,
      data: configured.map((p) => ({
        provider: p.provider,
        defaultModel: p.defaultModel ?? null,
        isDefault: p.provider === defaultProvider,
      })),
      meta: {
        // Hard, machine-readable directive. The agent system prompt tells the
        // model to read THIS field and copy it verbatim into every agent node.
        useThisProvider: defaultProvider,
        directive: defaultProvider
          ? `For every agent_* node, set config.provider="${defaultProvider}" exactly. Do NOT pick a different one based on model knowledge.`
          : 'No LLM provider configured for this tenant and Liara is disabled. Surface a clear error to the user — do NOT scaffold agent_* nodes.',
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `list_llm_providers fallito: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function listDraftNodesHandler(session: ScaffoldSession): ToolResult {
  return {
    ok: true,
    data: {
      nodes: session.draft.nodes.map((n) => ({ id: n.id, defId: n.defId, name: n.name ?? null })),
      edges: session.draft.edges,
    },
  };
}
