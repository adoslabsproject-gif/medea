/**
 * Registrazione dei 28 tool dell'AI Scaffold agent nel Tool Registry.
 *
 * Pattern Federico-grade STATE-OF-THE-ART 2026:
 *   • Single source of truth: nome + descrizione + schema + handler per ogni tool
 *   • Validation declarative via Zod (no più `if (typeof X === 'string')` sparpagliati)
 *   • Type-safety end-to-end: `z.infer<typeof schema>` deriva il tipo args
 *   • Auto-introspettivo: `toAnthropicToolsSpec()` / `toOpenAIToolsSpec()`
 *     generano spec native compatibile con Anthropic Messages API tool_use
 *     e OpenAI function calling — pronto per migrazione futura a tool_use
 *     nativo senza re-write del registry
 *   • Dispatch O(1) Map.get vs switch O(n)
 *   • Plug-in friendly: nuovi tool si aggiungono registrando un oggetto,
 *     niente switch case modify, niente conflitti di merge
 *
 * Riferimenti pattern:
 *   • Vercel AI SDK: https://sdk.vercel.ai/docs/foundations/tools
 *   • Anthropic Tool Use: https://docs.anthropic.com/claude/docs/tool-use
 *   • OpenAI Function Calling: https://platform.openai.com/docs/guides/function-calling
 *
 * Importato come side-effect da `ai-scaffold.service.ts` al boot — la
 * registrazione popola il singleton `toolRegistry` una volta sola.
 */
import { z } from 'zod';
import { defineTool, toolRegistry, EmptyArgs, type ToolResult } from './tool-registry.js';
import type { ScaffoldSession } from '@/services/ai-scaffold.service.js';

// ─────────────────────────────────────────────────────────────────────────
// Discovery (12 tool) — read-only inspection, no side effect.
// L'agente li chiama per orientarsi prima di mutare.
// ─────────────────────────────────────────────────────────────────────────

toolRegistry.register(defineTool({
  name: 'list_databases',
  description: 'Elenca i database connection del tenant con table count + engine. Use case: decidere DOVE persistere dati ("save nell\'esistente vs nuovo DB"). Output lean: no credentials, no full schema.',
  schema: EmptyArgs,
  handler: (session: ScaffoldSession) => session.toolListDatabases() as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'read_db_schema',
  description: 'Schema completo (tabelle + colonne + tipi + PK + nullable) di un database. Use case: prima di add_node che usa db_query/db_insert, verificare le colonne reali.',
  schema: z.object({ databaseId: z.string().min(1) }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolReadDbSchema(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_existing_workflows',
  description: 'Lista workflow esistenti del tenant (id/name/desc/enabled, no full nodes). Use case: ispirarsi a workflow simili, evitare duplicati.',
  schema: EmptyArgs,
  handler: async (session: ScaffoldSession) => await session.toolListWorkflows() as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'read_workflow',
  description: 'Workflow completo (nodes + edges + nodeDefs) per analisi o cloning. Tenant-scoped.',
  schema: z.object({ workflowId: z.string().min(1).optional(), id: z.string().min(1).optional() }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolReadWorkflow(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_node_catalog',
  description: 'Catalogo nodi runtime. Senza args: lista breve. Con defId: full config-field schema (tipi/enum/regex). Per add_node corretto.',
  schema: z.object({ type: z.string().optional(), defId: z.string().optional() }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolListNodeCatalog(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_email_accounts',
  description: 'Account email IMAP/SMTP pre-configurati dal tenant admin. Referenziati nei nodi via systemAccountId. Critico per evitare credenziali hardcoded.',
  schema: EmptyArgs,
  handler: (session: ScaffoldSession) => session.toolListEmailAccounts() as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_secrets',
  description: 'NOMI dei secret disponibili (mai i valori). L\'agente li referenzia con {{secrets.NOME}} nei config — boundary "dati sensibili a parte".',
  schema: EmptyArgs,
  handler: (session: ScaffoldSession) => session.toolListSecrets() as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_llm_providers',
  description: 'LLM provider con API key configurata nel tenant. Use case: scegliere provider per agent_extractor/agent_* nodes invece di hardcodare vendor.',
  schema: EmptyArgs,
  handler: (session: ScaffoldSession) => session.toolListLlmProviders() as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_draft_nodes',
  description: 'Stato corrente del draft (nodes + edges). Aiuta l\'agente a riorientarsi mid-loop dopo molti add_node/connect_nodes.',
  schema: EmptyArgs,
  handler: (session: ScaffoldSession) => session.toolListDraftNodes() as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'list_recent_runs',
  description: 'Ultimi N run del tenant (id/status/durata/errori, NO step output). Tenant-scoped. Use case: diagnostic "perché il workflow X ha fallito ieri".',
  schema: z.object({
    limit: z.number().int().positive().max(100).optional(),
    workflowId: z.string().optional(),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolListRecentRuns(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'read_run',
  description: 'Dettaglio singolo run: steps con status/duration/error REDACTED (no PII, no payload base64). Per output completo serve UI Run Inspector.',
  schema: z.object({ runId: z.string().min(1) }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolReadRun(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'check_settings_health',
  description: 'Riepilogo settings del tenant (email/secrets/LLM/DB count). L\'agente decide se chiedere all\'utente di configurare X prima di costruire il workflow.',
  schema: EmptyArgs,
  handler: (session: ScaffoldSession) => session.toolCheckSettingsHealth() as ToolResult,
}));

// ─────────────────────────────────────────────────────────────────────────
// Mutation DB (6 tool) — schema migrations via DbStudioService.applyMigration.
// Tutti idempotent-friendly; cross-tenant blocked dal service layer.
// ─────────────────────────────────────────────────────────────────────────

const ColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  constraints: z.object({
    nullable: z.boolean().optional(),
    unique: z.boolean().optional(),
    primaryKey: z.boolean().optional(),
  }).optional(),
});

toolRegistry.register(defineTool({
  name: 'create_database',
  description: 'Crea un nuovo database SQLite locale del tenant. Usalo quando list_databases ritorna lista vuota e il workflow richiede storage. Restituisce { databaseId, name } da usare in create_table successivo. NO credentials richieste — SQLite vive nel volume tenant.',
  schema: z.object({
    name: z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]*$/i, 'name: solo [a-zA-Z0-9_], inizio con lettera'),
    description: z.string().max(500).optional(),
  }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolCreateDatabase(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'create_table',
  description: 'Crea una nuova tabella con colonne tipizzate. Cache schema aggiornata automaticamente.',
  schema: z.object({
    databaseId: z.string().min(1),
    table: z.object({
      name: z.string().min(1),
      columns: z.array(ColumnSchema).min(1),
    }),
  }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolCreateTable(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'add_column',
  description: 'Aggiunge una colonna a una tabella esistente. ALTER TABLE ADD COLUMN.',
  schema: z.object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    column: ColumnSchema,
  }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolAddColumn(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'drop_column',
  description: 'DROP COLUMN. Last-resort destructive op — usata per correggere errori di create_table.',
  schema: z.object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    columnName: z.string().min(1).optional(),
    column: z.string().min(1).optional(),
  }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolDropColumn(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'drop_table',
  description: 'DROP TABLE — DISTRUTTIVO. Richiede confirmTableName === tableName come safety gate (stesso pattern del SqlEditor).',
  schema: z.object({
    databaseId: z.string().min(1),
    tableName: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    confirmTableName: z.string().min(1),
  }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolDropTable(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'rename_column',
  description: 'NON SUPPORTATO uniformemente cross-engine. Ritorna error con workaround suggerito (add_column + copy via workflow + drop_column).',
  schema: z.object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolRenameColumn(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'add_index',
  description: 'Crea un index (B-tree) su una o più colonne. Use case: ottimizzare db_query frequenti su colonne specifiche.',
  schema: z.object({
    databaseId: z.string().min(1),
    table: z.string().min(1),
    indexName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    columns: z.array(z.string()).min(1),
    unique: z.boolean().optional(),
  }),
  handler: async (session: ScaffoldSession, args: unknown) =>
    await session.toolAddIndex(args as Record<string, unknown>) as ToolResult,
}));

// ─────────────────────────────────────────────────────────────────────────
// Planning Phase (1 tool) — PHASE 0 obbligatoria del wizard 2026-05-31.
// Liara DEVE chiamare propose_plan PRIMA di add_node/connect_nodes/finalize.
// Vedi plan-handler.ts per validazioni + requirePlan gate.
// ─────────────────────────────────────────────────────────────────────────

toolRegistry.register(defineTool({
  name: 'propose_plan',
  description: 'PHASE 0 OBBLIGATORIA: decomponi il goal in lista nominata di nodi + edges + reasoning. Il server valida vs complessità del goal e contro il catalogo runtime. Solo dopo accept, add_node/connect_nodes/finalize_workflow diventano disponibili. Pattern think-then-act stile state-of-the-art 2026 (Plan-and-Execute, ReAct + planning).',
  schema: z.object({
    reasoning: z.string().min(60).describe('Spiega in italiano come hai decomposto il goal e perché ogni nodo serve. >= 60 chars.'),
    nodes: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_]*$/i, 'snake_case alfanumerico'),
      defId: z.string().min(1).describe('defId esistente nel catalogo (vedi list_node_catalog)'),
      purpose: z.string().min(10).describe('Cosa fa questo nodo nel flow. >= 10 chars.'),
    })).min(1),
    edges: z.array(z.object({
      from: z.string().describe('id di un nodo del plan'),
      to: z.string().describe('id di un nodo del plan'),
      fromPort: z.string().optional().describe('"true"|"false" per logic_if; case name per logic_switch'),
    })),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolProposePlan(args as Record<string, unknown>) as ToolResult,
}));

// ─────────────────────────────────────────────────────────────────────────
// Mutation Workflow (7 tool) — edits sul draft in-memory. O(n) su array
// piccoli (workflow rarely > 50 nodes); nessun bisogno di Map ottimizzato.
// GATE: ogni tool sotto richiede session.plan accepted (vedi requirePlan).
// ─────────────────────────────────────────────────────────────────────────

toolRegistry.register(defineTool({
  name: 'add_node',
  description: 'Aggiunge un nodo al draft. Config validato per-field via schema del node catalog (enum/regex/required).',
  schema: z.object({
    id: z.string().min(1),
    defId: z.string().min(1),
    label: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolAddNode(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'update_node',
  description: 'Patch merge sui field del nodo. Re-valida contro lo schema. Merge-semantic: unspecified keys mantengono il valore precedente.',
  schema: z.object({
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    label: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolUpdateNode(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'delete_node',
  description: 'Rimuove nodo + edges dipendenti (cascade). Mantiene invariante: no orphan edges nel draft.',
  schema: z.object({ id: z.string().min(1) }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolDeleteNode(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'connect_nodes',
  description: 'Aggiunge edge from→to. fromPort="true"|"false" SOLO per logic_if/switch branch.',
  schema: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    fromPort: z.string().optional(),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolConnectNodes(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'disconnect_nodes',
  description: 'Rimuove edge (idempotente, no error se gone). Identificato da (from, to, fromPort?) triple.',
  schema: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    fromPort: z.string().optional(),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolDisconnectNodes(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'finalize_workflow',
  description: 'Chiude e ritorna il workflow. Chiamato SOLO dopo TUTTI i nodi+edge. Double-check orphan edges.',
  schema: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolFinalizeWorkflow(args as Record<string, unknown>) as ToolResult,
}));

toolRegistry.register(defineTool({
  name: 'abort',
  description: 'Impossibile completare il workflow. L\'agente DEVE spiegare il motivo per audit.',
  schema: z.object({ reason: z.string().min(1) }),
  handler: (session: ScaffoldSession, args: unknown) =>
    session.toolAbort(args as Record<string, unknown>) as ToolResult,
}));
