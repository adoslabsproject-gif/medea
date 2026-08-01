/**
 * SQLite base schema — table CREATE statements + indexes.
 * Eseguito una volta a boot da runMigrations() via sqlite.exec().
 * Modifiche schema evolutive (ALTER TABLE / ADD COLUMN) restano in
 * migrate.ts ensureColumn() — qui solo tabelle nuove.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL DEFAULT '1.0.0',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  node_defs_json TEXT NOT NULL DEFAULT '[]',
  breakpoints_json TEXT,
  tags_json TEXT,
  folder_id TEXT,
  on_error_json TEXT,
  concurrency_limit INTEGER,
  -- 2026-06-07: tier-aware logging. Dichiarate qui (oltre al helper ALTER in
  -- db.ts per i DB pre-esistenti) così i DB freschi le hanno dalla CREATE e lo
  -- schema-coverage gate le vede senza dover estrarre ALTER interpolati.
  ephemeral_runs INTEGER NOT NULL DEFAULT 0,
  run_verbosity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  owner_id TEXT
);
CREATE INDEX IF NOT EXISTS workflows_tenant_idx ON workflows(tenant_id);
CREATE INDEX IF NOT EXISTS workflows_name_idx ON workflows(name);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  tenant_id TEXT DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_type TEXT,
  trigger_payload_json TEXT,
  input TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  paused_json TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER,
  triggered_by TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_workflow_idx ON runs(workflow_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);
CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs(started_at);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT DEFAULT 'default',
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS credentials_provider_idx ON credentials(provider);
CREATE INDEX IF NOT EXISTS credentials_tenant_name_idx ON credentials(tenant_id, name);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT DEFAULT 'default',
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata_json TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  oauth_provider TEXT,
  oauth_subject TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_idx ON users(tenant_id, email);

CREATE TABLE IF NOT EXISTS viewer_share_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS viewer_share_tokens_tenant_idx ON viewer_share_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS viewer_share_tokens_token_idx ON viewer_share_tokens(token);

-- ─────────────────────────────────────────────────────────────────────────
-- v2 enterprise features: checkpoints, async frames, distributed workers
-- ─────────────────────────────────────────────────────────────────────────

-- Snapshot of outputsById taken every N nodes during a run. On crash, the
-- CheckpointRecoveryService picks up the most recent snapshot for each
-- 'running' run that has no endedAt and resumes from there.
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  /** Node id at which the snapshot was taken (the most recently executed). */
  at_node_id TEXT NOT NULL,
  /** Serialized Map<nodeId, output> — restored as engine outputsById. */
  outputs_by_id_json TEXT NOT NULL,
  /** Visited node set, so resume doesn't re-execute already-done nodes. */
  visited_json TEXT NOT NULL,
  /** Pending BFS queue when snapshot was taken. */
  pending_queue_json TEXT NOT NULL,
  /** GAP #2 (paired items): serialized RunItemGraph — nodeId → ExecutionItem[].
      Nullable: righe pre-4.2 non lo hanno (resume degrada a lineage assente). */
  item_graph_json TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_checkpoints_run_idx ON workflow_checkpoints(run_id);
CREATE INDEX IF NOT EXISTS workflow_checkpoints_workflow_idx ON workflow_checkpoints(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_checkpoints_created_idx ON workflow_checkpoints(created_at);

-- Workflows currently suspended on a logic_wait_signal node. The engine
-- writes a row here when it encounters a wait_signal, returns immediately,
-- and the SignalService finds the row when the matching POST /signals/:name
-- arrives. timeout_at is a hard upper bound (default 30 days, configurable).
CREATE TABLE IF NOT EXISTS paused_workflows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  signal_name TEXT NOT NULL,
  /** Node id of the wait_signal node — resume continues from here. */
  at_node_id TEXT NOT NULL,
  /** Engine state snapshot needed to resume: outputs, visited, queue. */
  outputs_by_id_json TEXT NOT NULL,
  visited_json TEXT NOT NULL,
  pending_queue_json TEXT NOT NULL,
  /** GAP #2 (paired items): serialized RunItemGraph — nodeId → ExecutionItem[].
      Nullable: righe pre-4.2 non lo hanno (resume degrada a lineage assente). */
  item_graph_json TEXT,
  /** Payload received when the signal fires (set on resume). */
  resume_payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | resumed | timeout | cancelled
  /** Hard deadline — after this the row is purged & workflow continues with default payload. */
  timeout_at TEXT,
  created_at TEXT NOT NULL,
  resumed_at TEXT
);
CREATE INDEX IF NOT EXISTS paused_workflows_signal_idx ON paused_workflows(signal_name, status);
CREATE INDEX IF NOT EXISTS paused_workflows_tenant_idx ON paused_workflows(tenant_id);
CREATE INDEX IF NOT EXISTS paused_workflows_timeout_idx ON paused_workflows(timeout_at) WHERE status = 'waiting';

-- Embedding persistiti del catalogo nodi (catalog-retrieval, RAG). Content-
-- addressed: text_hash = sha256(embedText del record) → il vettore si
-- ricalcola SOLO quando il testo del nodo cambia, mai a ogni boot. Senza
-- questa tabella ogni processo ri-embeddava ~190 nodi alla prima query
-- (10-20s di warm-up percepito dall'utente).
CREATE TABLE IF NOT EXISTS catalog_embeddings (
  text_hash TEXT PRIMARY KEY,
  vector_json TEXT NOT NULL,
  dims INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Heartbeat table for distributed worker coordination. Each worker process
-- writes its id + lastHeartbeat every 10s. Stale workers (no heartbeat > 60s)
-- have their currently-claimed runs reassigned by a janitor task.
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', -- idle | busy | draining
  current_run_id TEXT,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  runs_executed INTEGER NOT NULL DEFAULT 0,
  version TEXT
);
CREATE INDEX IF NOT EXISTS workers_heartbeat_idx ON workers(last_heartbeat_at);
CREATE INDEX IF NOT EXISTS workers_status_idx ON workers(status);

-- ════════════════════════════════════════════════════════════════════
-- AI Conversations (2026-05-30) — Phase 1 of AI-SCALING-100-TENANTS
-- ════════════════════════════════════════════════════════════════════
--
-- ai_conversations: top-level entity per chat session.
-- ai_messages: turns (user/assistant/system) with embeddings for RAG.
--
-- Isolation by design: per-tenant SQLite DB. Zero cross-tenant leak
-- possible at infrastructure level (each runtime container has its own
-- /data/flowforge.sqlite).
--
-- Scope by (user_id, workspace_id, surface):
--   - editor_chat:      sidebar AiAssistantPanel (workspace-scoped)
--   - wizard_scaffold:  modal Create-with-AI (one-shot, workflow-scoped)
--   - help_chat:        docs/FAQ assistant (user-scoped)
--
-- Sliding window: SELECT last 20 turns OR last 8K tokens, whichever first.
-- Summary compaction: every 50 turns, Liara generates summary, stored on
-- ai_conversations.summary; old turns kept for RAG retrieval via embedding
-- cosine similarity (BGE-M3 1024-dim).
--
-- GDPR: soft-delete via deleted_at, hard-purge by cron after 30gg.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,                   -- UUID v4
  user_id TEXT NOT NULL,                 -- FK users.id (logical, no FK enforcement for soft-delete safety)
  workspace_id TEXT,                     -- nullable for help_chat (user-scoped only)
  workflow_id TEXT,                      -- nullable, set for editor_chat scoped to a specific workflow draft
  surface TEXT NOT NULL CHECK (surface IN ('editor_chat', 'wizard_scaffold', 'help_chat', 'node_editor', 'db_studio')),
  title TEXT,                            -- LLM-derived from first user message (lazy on background job)
  message_count INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  summary TEXT,                          -- compacted summary of older turns (NULL until first compaction)
  summary_at TEXT,                       -- ISO timestamp of last summary compaction
  summary_message_count INTEGER NOT NULL DEFAULT 0, -- message_count at last summary
  provider_pin TEXT,                     -- optional: pin conversation to a specific provider (Liara/Anthropic/etc.)
  created_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  deleted_at TEXT                        -- soft-delete (GDPR)
);

CREATE INDEX IF NOT EXISTS ai_conv_user_idx
  ON ai_conversations(user_id, last_message_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_conv_workspace_idx
  ON ai_conversations(workspace_id, last_message_at DESC)
  WHERE workspace_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_conv_surface_idx
  ON ai_conversations(user_id, surface, last_message_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_conv_deleted_purge_idx
  ON ai_conversations(deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,                   -- UUID v4
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  tokens INTEGER,                        -- token count (input for user/system, output for assistant)
  provider TEXT,                         -- provider used for this assistant turn (NULL for user turns)
  model TEXT,                            -- model id used
  latency_ms INTEGER,                    -- assistant turn only
  cost_usd_estimate REAL,                -- approx cost for billing audit (assistant only)
  embedding BLOB,                        -- BGE-M3 1024-dim float32 binary (4096 bytes), populated async
  embedded_at TEXT,                      -- ISO timestamp when embedding was computed (NULL = pending/skipped)
  patch_json TEXT,                       -- for assistant turns with workflow patch proposal (JSON)
  in_summary INTEGER NOT NULL DEFAULT 0, -- 1 if this message has been folded into a parent summary (legacy retention only)
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_msg_conv_idx ON ai_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ai_msg_pending_embed_idx
  ON ai_messages(id)
  WHERE embedded_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_msg_provider_idx ON ai_messages(provider, created_at) WHERE provider IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- AI Workflow Calls (2026-05-30) — runtime nodes that invoke LLM
-- ════════════════════════════════════════════════════════════════════
--
-- Distinct from ai_messages (conversational chat). This tracks every LLM
-- call performed BY A WORKFLOW NODE EXECUTOR during a run:
--   - agent_classifier, agent_extractor, agent_summarizer
--   - ai_anthropic, ai_openai, ai_gemini, ai_mistral
--   - community nodes with AI actions (ai_action_id flagged)
--
-- Linked to runs.id + workflow_id + node_id triple. Cost metering for
-- billing audit + per-tenant token budget enforcement (shared with chat).
--
-- Same per-tenant SQLite isolation as ai_conversations.

CREATE TABLE IF NOT EXISTS ai_workflow_calls (
  id TEXT PRIMARY KEY,                   -- UUID v4
  run_id TEXT NOT NULL,                  -- runs.id
  workflow_id TEXT NOT NULL,             -- workflows.id
  node_id TEXT NOT NULL,                 -- node within the workflow
  def_id TEXT NOT NULL,                  -- node def id (e.g. agent_classifier, ai_anthropic)
  provider TEXT NOT NULL,                -- liara | anthropic | openai | gemini | mistral | ollama
  model TEXT,                            -- model id used
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,                  -- input + output for fast sum queries
  latency_ms INTEGER,
  cost_usd_estimate REAL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'rate_limited', 'circuit_open', 'timeout')),
  error_message TEXT,                    -- when status != 'ok'
  cache_hit TEXT CHECK (cache_hit IN ('none', 'semantic', 'prompt')),  -- which cache layer hit (NULL/none = miss)
  queue_wait_ms INTEGER,                 -- time spent in BullMQ queue before dispatch
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ai_wf_calls_run_idx ON ai_workflow_calls(run_id, created_at);
CREATE INDEX IF NOT EXISTS ai_wf_calls_workflow_idx ON ai_workflow_calls(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_wf_calls_provider_idx ON ai_workflow_calls(provider, created_at);
CREATE INDEX IF NOT EXISTS ai_wf_calls_status_idx ON ai_workflow_calls(status, created_at) WHERE status != 'ok';

-- ════════════════════════════════════════════════════════════════════
-- AI Budget per tenant (unified: chat + workflow calls)
-- ════════════════════════════════════════════════════════════════════
--
-- Single source of truth for per-tenant LLM cost & token consumption.
-- Updated atomically after every successful LLM call (both ai_messages
-- assistant turns and ai_workflow_calls). Powers:
--   - Plan limit enforcement (Free 100K tok/day, Pro 10M/day, ...)
--   - Cost dashboard for tenant admin
--   - Burst detection (10x baseline → alert + auto-pause)
--   - Billing reconciliation at month-end

CREATE TABLE IF NOT EXISTS ai_budget_daily (
  date TEXT NOT NULL,                    -- YYYY-MM-DD UTC
  source TEXT NOT NULL CHECK (source IN ('chat', 'workflow')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, source)
);

CREATE INDEX IF NOT EXISTS ai_budget_date_idx ON ai_budget_daily(date DESC);

-- ════════════════════════════════════════════════════════════════════
-- AI Workflow Templates (2026-05-31) — Livello 1 per-tenant cache
-- ════════════════════════════════════════════════════════════════════
--
-- Cache locale dei workflow generati dal singleshot scaffold. Per
-- request simili futuri, recuperiamo template gia\` validato + lo
-- riusiamo direttamente (>=0.90 score) o lo iniettiamo come few-shot
-- (0.70-0.90 score). Riduce latency 60s → 200ms + costo GPU.
--
-- Retrieval pipeline:
--   1. graph_signature exact-match → instant hit (canonical defId chain)
--   2. prompt token-overlap Jaccard (precise & cheap) — fallback
--   3. BGE-M3 cosine (popolato async, future) — semantic
--   Final score = 0.45*graph_overlap + 0.35*prompt_jaccard + 0.10*success_rate + 0.10*cosine
--
-- Per-tenant: isolato per definizione (SQLite del container = 1 tenant).
-- GDPR: hard-purge cascade su tenant deletion (container destroy).

CREATE TABLE IF NOT EXISTS ai_workflow_templates (
  id TEXT PRIMARY KEY,                          -- UUID v4
  prompt_text TEXT NOT NULL,                    -- richiesta utente originale (NL)
  prompt_tokens_json TEXT NOT NULL,             -- JSON array di token normalizzati (lowercase, no stopwords) per Jaccard
  graph_signature TEXT NOT NULL,                -- canonical: "trigger_X>defId_A>defId_B|trigger_Y>defId_C"
  graph_def_ids_json TEXT NOT NULL,             -- JSON array defIds (per filter "ha telegram?")
  workflow_json TEXT NOT NULL,                  -- workflow completo serializzato
  name TEXT NOT NULL,                           -- nome workflow (per UI list)
  language TEXT NOT NULL DEFAULT 'it',          -- detect lingua prompt (it/en/...)
  prompt_embedding BLOB,                        -- BGE-M3 1024d float32 LE (4096 bytes) — populated async future
  embedded_at TEXT,                             -- ISO when embedding popolato
  imported_count INTEGER NOT NULL DEFAULT 1,    -- # volte importato dall'utente
  success_count INTEGER NOT NULL DEFAULT 0,    -- # run successful (boost)
  fail_count INTEGER NOT NULL DEFAULT 0,       -- # run failed (penalty)
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Livello 2 community gallery (opt-in)
  shared_with_community INTEGER NOT NULL DEFAULT 0,
  shared_template_id TEXT,                      -- FK al shared_workflow_templates portal-side (NULL = non condiviso)
  shared_at TEXT
);

CREATE INDEX IF NOT EXISTS ai_workflow_templates_signature_idx ON ai_workflow_templates(graph_signature);
CREATE INDEX IF NOT EXISTS ai_workflow_templates_last_used_idx ON ai_workflow_templates(last_used_at DESC);
CREATE INDEX IF NOT EXISTS ai_workflow_templates_shared_idx ON ai_workflow_templates(shared_with_community, shared_template_id)
  WHERE shared_with_community = 1;

-- ════════════════════════════════════════════════════════════════════════
-- Custom Nodes 2026 — Cappella Sistina Custom Node Editor (Fase 1)
-- ════════════════════════════════════════════════════════════════════════
-- Tabella tenant-isolated: ogni container ha solo i SUOI custom nodes.
-- Container Docker = isolamento fisico cross-tenant (GDPR-grade).
--
-- Lifecycle status:
--   draft         — work-in-progress, NON installato nel nodeRegistry runtime
--   candidate     — compilato + testato, in attesa publish
--   published_priv — installato runtime locale (visibile in palette workflow editor)
--   marketplace_pending — submission inviata al portal admin review queue
--   marketplace_published — approvato + live nel registry pubblico
--   archived      — soft-delete (preservato per audit + rollback)
--
-- Versioning: ogni save = snapshot in custom_node_versions (append-only).
-- Rollback semver carica snapshot precedente.
--
-- Test runs: ultimi 20 conservati in column JSON per inspector inline.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS custom_nodes (
  id TEXT PRIMARY KEY,                            -- UUID v4
  workspace_id TEXT NOT NULL,                     -- FLOWFORGE_TENANT_ID (denormalized for analytics)
  owner_user_id TEXT NOT NULL,                    -- chi ha creato
  slug TEXT NOT NULL,                             -- es. "my-stripe-webhook" (unique per tenant)
  display_name TEXT NOT NULL,                     -- es. "My Stripe Webhook"
  description TEXT,                               -- breve descrizione palette
  icon_svg TEXT,                                  -- SVG inline (max 32KB)
  category TEXT,                                  -- "AI Agents" / "Database" / "Custom" / ...
  semver TEXT NOT NULL DEFAULT '0.1.0',           -- semver attuale (incrementato a ogni save snapshot)
  status TEXT NOT NULL DEFAULT 'draft',           -- lifecycle (vedi sopra)
  source_executor TEXT NOT NULL,                  -- executor.ts source (utente)
  source_definition TEXT NOT NULL,                -- definition.ts source
  source_schema TEXT NOT NULL,                    -- schema.ts source
  compiled_executor TEXT,                         -- esbuild output IIFE bundle (popolato dopo compile)
  compile_warnings TEXT,                          -- JSON array di {severity, line, col, message, code}
  compile_at TEXT,                                -- ISO timestamp ultima compile riuscita
  test_runs TEXT,                                 -- JSON array ultimi 20 test runs {at, input, output, ok, durationMs}
  marketplace_submission_id TEXT,                 -- ref portal-side flowforge.marketplace_submissions.id (se submitted)
  marketplace_submitted_at TEXT,
  marketplace_published_at TEXT,
  paypal_node_id TEXT,                            -- id remoto registry pubblico (se published)
  integrity_digest TEXT,                          -- sha256 canonico del pacchetto (compute al compile)
  integrity_signature TEXT,                       -- HMAC-SHA256(registrySecret, digest)
  integrity_algo TEXT,                            -- algoritmo integrità (es. 'sha256+hmac-sha256')
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT custom_nodes_status_check CHECK (
    status IN ('draft','candidate','published_priv','marketplace_pending','marketplace_published','archived')
  ),
  CONSTRAINT custom_nodes_slug_format CHECK (
    length(slug) BETWEEN 2 AND 64 AND slug GLOB '[a-z0-9][a-z0-9_-]*'
  ),
  CONSTRAINT custom_nodes_semver_format CHECK (
    semver GLOB '[0-9]*.[0-9]*.[0-9]*'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_nodes_workspace_slug_unique
  ON custom_nodes(workspace_id, slug)
  WHERE status != 'archived';
CREATE INDEX IF NOT EXISTS custom_nodes_status_idx ON custom_nodes(status);
CREATE INDEX IF NOT EXISTS custom_nodes_owner_idx ON custom_nodes(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS custom_nodes_marketplace_idx
  ON custom_nodes(marketplace_submitted_at DESC)
  WHERE marketplace_submitted_at IS NOT NULL;

-- Append-only version history per rollback semver
CREATE TABLE IF NOT EXISTS custom_node_versions (
  id TEXT PRIMARY KEY,                            -- UUID v4
  custom_node_id TEXT NOT NULL REFERENCES custom_nodes(id) ON DELETE CASCADE,
  semver TEXT NOT NULL,                           -- semver di questo snapshot
  source_executor TEXT NOT NULL,
  source_definition TEXT NOT NULL,
  source_schema TEXT NOT NULL,
  compiled_executor TEXT,                         -- snapshot del bundle compilato
  changelog TEXT,                                 -- nota utente (es. "fix retry logic")
  created_by TEXT NOT NULL,                       -- user_id che ha fatto il save
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_node_versions_unique
  ON custom_node_versions(custom_node_id, semver);
CREATE INDEX IF NOT EXISTS custom_node_versions_node_idx
  ON custom_node_versions(custom_node_id, created_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- F2 (2026-06-10): tabelle SSO/folders/share consolidate dallo schema inline che
-- viveva dentro i route handler (oauth.ts, saml.ts, sso.ts, folders.ts,
-- share.ts). Lo schema ora ha un'unica fonte (questo file, applicato da
-- runMigrations al boot PRIMA di servire richieste) → niente drift, niente DDL
-- a request-time. Definizioni IDENTICHE a quelle inline rimosse.
-- ════════════════════════════════════════════════════════════════════════════

-- OAuth/OIDC enterprise SSO — provider config + transient PKCE state
CREATE TABLE IF NOT EXISTS oauth_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  -- client_secret: legacy plaintext (record storici). I NUOVI record lo lasciano
  -- '' e cifrano nelle 6 colonne sotto (envelope AES-256-GCM, vedi lib/oauth-secret).
  client_secret TEXT NOT NULL DEFAULT '',
  client_secret_ciphertext TEXT,
  client_secret_nonce TEXT,
  client_secret_auth_tag TEXT,
  client_secret_dek_ciphertext TEXT,
  client_secret_dek_nonce TEXT,
  client_secret_dek_auth_tag TEXT,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'openid email profile',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, provider)
);
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_state_expires_idx ON oauth_state(expires_at);

-- SAML 2.0 enterprise SSO — per-tenant IdP config
CREATE TABLE IF NOT EXISTS saml_providers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  entry_point TEXT NOT NULL,
  issuer TEXT NOT NULL,
  cert TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, provider)
);

-- SSO JWE replay protection — JTI già consumati (anti-replay del bridge portal)
CREATE TABLE IF NOT EXISTS sso_jti_used (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_jti_expires ON sso_jti_used(expires_at);

-- Organizzazione workflow in cartelle (albero parent_id)
CREATE TABLE IF NOT EXISTS workflow_folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  parent_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_folders_tenant_idx ON workflow_folders(tenant_id, parent_id);

-- Link di condivisione read-only di un workflow (token pubblico + scadenza)
CREATE TABLE IF NOT EXISTS workflow_shares (
  token TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  created_by TEXT,
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS workflow_shares_workflow_idx ON workflow_shares(workflow_id);

-- system_flags — flag operativi del container tenant settati dal portal via
-- endpoint interno (es. read_only quando il workspace è in disk over-quota grace).
-- key/value generico, single-row per flag. Persistente → sopravvive al restart.
CREATE TABLE IF NOT EXISTS system_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;
