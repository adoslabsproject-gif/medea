import { sqliteTable, text, integer, blob, index } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').default('default'),
    name: text('name').notNull(),
    description: text('description'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    schemaVersion: text('schema_version').notNull().default('1.0.0'),
    nodesJson: text('nodes_json').notNull().default('[]'),
    edgesJson: text('edges_json').notNull().default('[]'),
    nodeDefsJson: text('node_defs_json').notNull().default('[]'),
    breakpointsJson: text('breakpoints_json'),
    tagsJson: text('tags_json'),
    folderId: text('folder_id'),
    onErrorJson: text('on_error_json'),
    /**
     * E4 (2026-06-06): id di un altro workflow del tenant che viene
     * triggerato automaticamente quando QUESTO workflow termina con status='error'.
     * Pattern n8n "errorWorkflow" + Auth0-grade fallback chain. Payload passato:
     *   { failedNodeId, error, runId, workflowId, triggerInput, attempt }
     * NULL = nessun error workflow (default; il run finisce in stato error e basta).
     * NB: separato da `onErrorJson` (policy retry/dlq INLINE per nodo).
     */
    errorWorkflowId: text('error_workflow_id'),
    concurrencyLimit: integer('concurrency_limit'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdBy: text('created_by'),
    ownerId: text('owner_id'),
    /**
     * Snapshot completo del workflow durante autosave (separato dalla
     * versione "ufficiale" eseguita dall'engine). NULL = no draft pendente.
     * Promosso a {nodesJson,edgesJson,...} su PUT /workflows/:id (manual
     * save). Azzerato anche su POST /workflows/:id/discard-draft.
     * Schema JSON: { name, description, enabled, schemaVersion, nodes[],
     * edges[], nodeDefs[], tags?, folderId?, onError?, concurrencyLimit?,
     * breakpoints? }
     */
    draftJson: text('draft_json'),
    draftUpdatedAt: text('draft_updated_at'),
    /**
     * 2026-06-07 (incident senza1dio disk-full): true → ogni run di questo
     * workflow è EPHEMERAL — niente INSERT in `runs` table, niente subscribe
     * agli step events, niente flush incrementale steps_json. L'output viene
     * comunque emesso al webhook caller (response normale), ma il trace non
     * è interrogabile post-fatto.
     *
     * Use case: workflow webhook proxy ad alta frequenza (stream relay HLS,
     * shorturl redirect, image-resize cdn-edge) dove ogni request = 1 row
     * con steps_json grande (binari base64). Su un tenant Free 1GB, 1500
     * row × 500KB = 700MB → SqliteError disk full → tutto il runtime down.
     *
     * Default false → comportamento pieno (audit trail + dashboard live).
     * UI: WorkflowMetaModal espone un toggle "Esecuzione effimera (no trace)"
     * con avviso che disabilita run history.
     */
    ephemeralRuns: integer('ephemeral_runs', { mode: 'boolean' }).notNull().default(false),
    /**
     * 2026-06-07 sera (tier-aware logging — sostituisce ephemeralRuns):
     *
     *  - `silent`  → niente INSERT in `runs`, niente subscribe step events,
     *                niente audit. Identico al vecchio ephemeralRuns=true.
     *                Dashboard live SSE funziona comunque (eventi run.step
     *                e run.completed sono emessi dall'event-bus a parte).
     *
     *  - `summary` → INSERT row con `steps_json = [{nodeId, status,
     *                durationMs, errorCount}]` — niente input/output,
     *                niente binari base64. Cronologia + ricerca per
     *                workflow/data/errore funziona. ~5KB/row vs ~500KB del
     *                full.
     *
     *  - `full`    → comportamento attuale: ogni step contiene input/output
     *                completi. Massimo debug, massima occupazione disco.
     *
     * Default fallback: il run.service legge ephemeralRuns per back-compat
     * (se runVerbosity NULL e ephemeralRuns=true → silent; altrimenti full).
     *
     * Plan tier gating: Free è forzato a 'silent' a livello applicativo —
     * il workflow.service rifiuta valori diversi se il tenant è su piano
     * Free. I tier paid scelgono liberamente.
     */
    runVerbosity: text('run_verbosity'),
  },
  (table) => ({
    tenantIdx: index('workflows_tenant_idx').on(table.tenantId),
    nameIdx: index('workflows_name_idx').on(table.name),
  }),
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').default('default'),
    // 2026-06-09 AUDIT FIX WE-3: aggiunto 'recovering' allo enum per supportare
    // l'atomic claim del CheckpointRecoveryService. Stato di transizione tra
    // crash detection e effective resume — runs in 'recovering' sono claimati
    // da un process specifico e non devono essere ri-claimati. La transizione
    // finale ('success'/'error'/'partial'/'paused'/'cancelled') è settata da
    // run.service.resumeFromCheckpoint a fine esecuzione.
    status: text('status', {
      enum: [
        'pending',
        'running',
        'recovering',
        'success',
        'partial',
        'error',
        'paused',
        'cancelled',
      ],
    })
      .notNull()
      .default('pending'),
    triggerType: text('trigger_type'),
    triggerPayloadJson: text('trigger_payload_json'),
    input: text('input').notNull().default(''),
    stepsJson: text('steps_json').notNull().default('[]'),
    pausedJson: text('paused_json'),
    errorCount: integer('error_count').notNull().default(0),
    totalDurationMs: integer('total_duration_ms'),
    triggeredBy: text('triggered_by'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => ({
    workflowIdx: index('runs_workflow_idx').on(table.workflowId),
    statusIdx: index('runs_status_idx').on(table.status),
    startedAtIdx: index('runs_started_at_idx').on(table.startedAt),
  }),
);

export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').default('default'),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    ciphertext: blob('ciphertext').notNull(),
    nonce: blob('nonce').notNull(),
    metadataJson: text('metadata_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdBy: text('created_by'),
  },
  (table) => ({
    providerIdx: index('credentials_provider_idx').on(table.provider),
    tenantNameIdx: index('credentials_tenant_name_idx').on(table.tenantId, table.name),
  }),
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tenantId: text('tenant_id').default('default'),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadataJson: text('metadata_json'),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    resourceIdx: index('audit_log_resource_idx').on(table.resourceType, table.resourceId),
    createdAtIdx: index('audit_log_created_at_idx').on(table.createdAt),
  }),
);

export const workflowsRelations = relations(workflows, ({ many }) => ({
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one }) => ({
  workflow: one(workflows, {
    fields: [runs.workflowId],
    references: [workflows.id],
  }),
}));

// ─────────────────────────────────────────────────────────────────────
// Janitor — Data Quality Self-Healing
//
// Tabelle interne al system SQLite. Le quarantine vere e proprie (i
// `quarantined_rows`) vivono sul DATA SOURCE TARGET (system o tenant)
// — vedi `adapters/quarantine.adapter.ts` che le crea via applyMigration
// cross-DB. Qui sotto stanno SOLO i metadata di coordinazione.
//
//   • janitor_locks       — lock distribuito named per regola con TTL
//   • janitor_rule_configs — config UI-driven di ogni regola per tenant
//   • janitor_run_log     — log esiti esecuzioni (append-only, audit/UI)
// ─────────────────────────────────────────────────────────────────────

export const janitorLocks = sqliteTable(
  'janitor_locks',
  {
    ruleId: text('rule_id').primaryKey(),
    heldBy: text('held_by').notNull(),
    acquiredAt: text('acquired_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => ({
    expiresIdx: index('janitor_locks_expires_idx').on(table.expiresAt),
  }),
);

export const janitorRuleConfigs = sqliteTable(
  'janitor_rule_configs',
  {
    ruleId: text('rule_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    schedule: text('schedule').notNull(),
    dataSourceRef: text('data_source_ref').notNull(),
    maxRowsPerRun: integer('max_rows_per_run').notNull(),
    severity: text('severity', { enum: ['critical', 'warning'] }).notNull(),
    paramsJson: text('params_json').notNull().default('{}'),
    notifyOnDetection: integer('notify_on_detection', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
    updatedBy: text('updated_by'),
  },
  (table) => ({
    tenantIdx: index('janitor_rule_configs_tenant_idx').on(table.tenantId),
  }),
);

export const janitorRunLog = sqliteTable(
  'janitor_run_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cycleId: text('cycle_id').notNull(),
    ruleId: text('rule_id').notNull(),
    tenantId: text('tenant_id').notNull().default('default'),
    dataSourceRef: text('data_source_ref').notNull(),
    targetTable: text('target_table').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    rowsDetected: integer('rows_detected').notNull().default(0),
    rowsRepaired: integer('rows_repaired').notNull().default(0),
    rowsQuarantined: integer('rows_quarantined').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    criticalCount: integer('critical_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    success: integer('success', { mode: 'boolean' }).notNull(),
    errorMessage: text('error_message'),
    triggeredBy: text('triggered_by').notNull(),
  },
  (table) => ({
    cycleIdx: index('janitor_run_log_cycle_idx').on(table.cycleId),
    ruleIdx: index('janitor_run_log_rule_idx').on(table.ruleId),
    tenantIdx: index('janitor_run_log_tenant_idx').on(table.tenantId),
    startedIdx: index('janitor_run_log_started_idx').on(table.startedAt),
  }),
);

export const janitorDslRules = sqliteTable(
  'janitor_dsl_rules',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    dataSourceRef: text('data_source_ref').notNull(),
    targetTable: text('target_table').notNull(),
    targetPkColumn: text('target_pk_column').notNull(),
    detectSql: text('detect_sql').notNull(),
    repairSql: text('repair_sql'),
    placeholdersJson: text('placeholders_json').notNull().default('{}'),
    tagsJson: text('tags_json').notNull().default('[]'),
    defaultSeverity: text('default_severity', { enum: ['critical', 'warning'] }).notNull(),
    defaultSchedule: text('default_schedule').notNull(),
    defaultMaxRowsPerRun: integer('default_max_rows_per_run').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdBy: text('created_by'),
  },
  (table) => ({
    tenantIdx: index('janitor_dsl_rules_tenant_idx').on(table.tenantId),
  }),
);

export type JanitorLockRow = typeof janitorLocks.$inferSelect;
export type JanitorRuleConfigRow = typeof janitorRuleConfigs.$inferSelect;
export type NewJanitorRuleConfigRow = typeof janitorRuleConfigs.$inferInsert;
export type JanitorRunLogRow = typeof janitorRunLog.$inferSelect;
export type NewJanitorRunLogRow = typeof janitorRunLog.$inferInsert;
export type JanitorDslRuleRow = typeof janitorDslRules.$inferSelect;
export type NewJanitorDslRuleRow = typeof janitorDslRules.$inferInsert;

export type WorkflowRow = typeof workflows.$inferSelect;
export type NewWorkflowRow = typeof workflows.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type CredentialRow = typeof credentials.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;

// ════════════════════════════════════════════════════════════════════════
// Custom Nodes 2026 — Cappella Sistina (Fase 1, 2026-06-08)
// ════════════════════════════════════════════════════════════════════════
export const customNodes = sqliteTable(
  'custom_nodes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    iconSvg: text('icon_svg'),
    category: text('category'),
    semver: text('semver').notNull().default('0.1.0'),
    status: text('status').notNull().default('draft'),
    sourceExecutor: text('source_executor').notNull(),
    sourceDefinition: text('source_definition').notNull(),
    sourceSchema: text('source_schema').notNull(),
    compiledExecutor: text('compiled_executor'),
    compileWarnings: text('compile_warnings'), // JSON array
    compileAt: text('compile_at'),
    testRuns: text('test_runs'), // JSON array max 20
    marketplaceSubmissionId: text('marketplace_submission_id'),
    marketplaceSubmittedAt: text('marketplace_submitted_at'),
    marketplacePublishedAt: text('marketplace_published_at'),
    paypalNodeId: text('paypal_node_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    statusIdx: index('custom_nodes_status_idx').on(t.status),
    ownerIdx: index('custom_nodes_owner_idx').on(t.ownerUserId, t.updatedAt),
  }),
);

export const customNodeVersions = sqliteTable(
  'custom_node_versions',
  {
    id: text('id').primaryKey(),
    customNodeId: text('custom_node_id')
      .notNull()
      .references(() => customNodes.id, { onDelete: 'cascade' }),
    semver: text('semver').notNull(),
    sourceExecutor: text('source_executor').notNull(),
    sourceDefinition: text('source_definition').notNull(),
    sourceSchema: text('source_schema').notNull(),
    compiledExecutor: text('compiled_executor'),
    changelog: text('changelog'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    nodeIdx: index('custom_node_versions_node_idx').on(t.customNodeId, t.createdAt),
  }),
);

export type CustomNodeRow = typeof customNodes.$inferSelect;
export type NewCustomNodeRow = typeof customNodes.$inferInsert;
export type CustomNodeVersionRow = typeof customNodeVersions.$inferSelect;
export type NewCustomNodeVersionRow = typeof customNodeVersions.$inferInsert;

/** Status enum — keep in sync with SQL CHECK constraint in migrate.schema.ts */
export type CustomNodeStatus =
  | 'draft'
  | 'candidate'
  | 'published_priv'
  | 'marketplace_pending'
  | 'marketplace_published'
  | 'archived';

/**
 * error_outbox — outbox DUREVOLE per la notifica di errore (at-least-once).
 * Una riga per (run_id, channel) → fallimento INDIPENDENTE per canale
 * (fanout|webhook|email). DDL single-source-of-truth in storage/error-outbox.ddl.ts
 * (keep in sync — il db-schema-coverage test morde sul drift).
 */
export const errorOutbox = sqliteTable(
  'error_outbox',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    channel: text('channel').notNull(),
    workflowId: text('workflow_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    errorNodeId: text('error_node_id'),
    errorMessage: text('error_message'),
    errorHash: text('error_hash'),
    durationMs: integer('duration_ms'),
    startedAt: text('started_at').notNull(),
    triggerType: text('trigger_type'),
    triggerInputJson: text('trigger_input_json'),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: text('next_attempt_at').notNull(),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    dueIdx: index('error_outbox_due_idx').on(t.status, t.nextAttemptAt),
    gcIdx: index('error_outbox_gc_idx').on(t.status, t.updatedAt),
  }),
);

export type ErrorOutboxRow = typeof errorOutbox.$inferSelect;
export type NewErrorOutboxRow = typeof errorOutbox.$inferInsert;
/** Canali di dispatch indipendenti (review #5). */
export type ErrorOutboxChannel = 'fanout' | 'webhook' | 'email';
/** pending = da dispatchare · done = consegnato · dead = poison oltre MAX_ATTEMPTS (#2). */
export type ErrorOutboxStatus = 'pending' | 'done' | 'dead';
