import { getDatabase } from './db.js';
import { ERROR_OUTBOX_DDL } from './error-outbox.ddl.js';
import { logger } from '@/lib/logger.js';
import { makePackageIntegrity, computePackageDigest, INTEGRITY_ENFORCED_FLAG } from '@/lib/custom-node-integrity.js';
import { registrySecret } from '@/lib/registry-secret.js';

interface DbStatement {
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number };
}
interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => DbStatement;
}

/**
 * Idempotent column addition. Reads SQLite's PRAGMA table_info() and only
 * issues ALTER TABLE ADD COLUMN when the column is missing. Safe to call on
 * every boot — schema evolution without a migration framework.
 */
/** Identificatore SQL semplice — i nomi tabella/colonna devono matcharlo prima
 *  di essere interpolati (SQLite non parametrizza gli identificatori, quindi la
 *  validazione è l'unico difesa corretta). */
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function assertSqlIdent(kind: string, value: string): void {
  if (!SQL_IDENT_RE.test(value)) {
    throw new Error(`ensureColumn: ${kind} "${value}" non è un identificatore SQL valido — atteso [A-Za-z_][A-Za-z0-9_]*.`);
  }
}

function ensureColumn(sqlite: SqliteDb, table: string, column: string, definition: string): void {
  // Hardening (audit MEDIUM): table/column interpolati → li vincoliamo a
  // identificatori SQL. `definition` è un literal statico delle migration ma
  // vietiamo terminatori di statement per impedire smuggling di un 2° comando.
  assertSqlIdent('table', table);
  assertSqlIdent('column', column);
  if (/[;]|--/u.test(definition)) {
    throw new Error(`ensureColumn: definition "${definition}" contiene un terminatore di statement — vietato.`);
  }
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const exists = cols.some((c) => c.name === column);
  if (exists) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info({ table, column }, 'Schema evolved: column added');
}

import { SCHEMA_SQL } from './migrate.schema.js';


export function runMigrations(): void {
  const { sqlite } = getDatabase();
  sqlite.exec(SCHEMA_SQL);

  // Schema evolution: add columns to pre-existing tables.
  // SQLite's CREATE TABLE IF NOT EXISTS does not add missing columns to
  // tables that were created by an earlier version. We bring them up to date
  // here. All calls are idempotent (PRAGMA-checked).
  ensureColumn(sqlite, 'users', 'oauth_provider', 'TEXT');
  ensureColumn(sqlite, 'users', 'oauth_subject', 'TEXT');
  // System accounts (auto-provisioned for CI / smoke tests). Hidden from
  // the /users API and protected from DELETE so the deploy doesn't keep
  // re-creating them after each manual cleanup. The TestAccountService
  // sets this flag when it provisions e2e@flowforge.local.
  ensureColumn(sqlite, 'users', 'is_system', 'INTEGER NOT NULL DEFAULT 0');

  // AUDIT FIX AUTH-2 (2026-06-09 HIGH): runtime tenant login lockout state.
  // Pre-fix: /auth/login non aveva rate-limit né lockout DB → brute-force
  // illimitato (anche con LoginGate "fallback only", l'endpoint è raggiungibile
  // su `<slug>.app.automazionezeli.com/auth/login`).
  // Post-fix: failed_login_count + locked_until per email-based lockout
  // progressive escalation (15min → 1h → 24h dopo recidive).
  ensureColumn(sqlite, 'users', 'failed_login_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'users', 'locked_until', 'TEXT'); // ISO timestamp or NULL
  ensureColumn(sqlite, 'users', 'lockout_level', 'INTEGER NOT NULL DEFAULT 0'); // 0=clean, 1=15min, 2=1h, 3=24h

  // SECURITY (#5 2026-06-20): client_secret OAuth cifrato (envelope AES-256-GCM,
  // parità con llm/email). 6 colonne nullable: i record legacy hanno solo
  // client_secret (plaintext) finché non vengono ri-salvati (vedi lib/oauth-secret).
  ensureColumn(sqlite, 'oauth_providers', 'client_secret_ciphertext', 'TEXT');
  ensureColumn(sqlite, 'oauth_providers', 'client_secret_nonce', 'TEXT');
  ensureColumn(sqlite, 'oauth_providers', 'client_secret_auth_tag', 'TEXT');
  ensureColumn(sqlite, 'oauth_providers', 'client_secret_dek_ciphertext', 'TEXT');
  ensureColumn(sqlite, 'oauth_providers', 'client_secret_dek_nonce', 'TEXT');
  ensureColumn(sqlite, 'oauth_providers', 'client_secret_dek_auth_tag', 'TEXT');

  // GAP #2 fase 4.2 (paired items): il RunItemGraph persiste negli snapshot
  // così .item/itemMatching risolvono anche DOPO pause/crash-resume. Nullable
  // per back-compat (righe pre-4.2 → resume con lineage assente, mai sbagliato).
  ensureColumn(sqlite, 'workflow_checkpoints', 'item_graph_json', 'TEXT');
  ensureColumn(sqlite, 'paused_workflows', 'item_graph_json', 'TEXT');

  // AUDIT FIX WE-9 (2026-06-09 HIGH): MCP exposure opt-in.
  // Pre-fix MCP /tools/list esponeva TUTTI i workflow enabled a qualsiasi
  // user autenticato → ACL bypass. Post-fix: solo workflow con mcp_exposed=1
  // sono visibili+invocabili via MCP. Default 0 (opt-in esplicito da editor).
  ensureColumn(sqlite, 'workflows', 'mcp_exposed', 'INTEGER NOT NULL DEFAULT 0');

  // v2 enterprise: BPMN-style message correlation for async frames.
  // match_key  = field name in the incoming signal body to compare against
  // match_value = value evaluated at pause time from the workflow expression
  // Only paused rows whose (match_key, match_value) matches the signal body
  // are resumed. When match_key is NULL, the signal fires to all rows.
  ensureColumn(sqlite, 'paused_workflows', 'match_key', 'TEXT');
  ensureColumn(sqlite, 'paused_workflows', 'match_value', 'TEXT');

  // Worker control intents — admin can queue a graceful restart, drain,
  // or concurrency change. The target worker reads its own row on each
  // heartbeat and acts on the intent (then clears the columns atomically).
  ensureColumn(sqlite, 'workers', 'requested_action', 'TEXT');             // 'restart' | 'drain' | 'resume' | NULL
  ensureColumn(sqlite, 'workers', 'requested_concurrency', 'INTEGER');
  ensureColumn(sqlite, 'workers', 'requested_action_at', 'TEXT');
  ensureColumn(sqlite, 'workers', 'requested_action_by', 'TEXT');
  ensureColumn(sqlite, 'workers', 'concurrency', 'INTEGER NOT NULL DEFAULT 1');

  // Registry community: integrità + firma del pacchetto custom-node (tamper
  // detection tra publish e install). Popolate al compile (persistCompileResult)
  // e verificate al cold-load (runtime-loader).
  ensureColumn(sqlite, 'custom_nodes', 'integrity_digest', 'TEXT');
  ensureColumn(sqlite, 'custom_nodes', 'integrity_signature', 'TEXT');
  ensureColumn(sqlite, 'custom_nodes', 'integrity_algo', 'TEXT');
  // Backfill ONE-TIME dei nodi legacy + flag di enforcement: senza, un
  // attaccante che azzera integrity_* ricadrebbe per sempre nel percorso
  // legacy fail-open (strip-attack). Col flag il loader blocca i runnable
  // senza record. Vedi backfillCustomNodeIntegrity.
  backfillCustomNodeIntegrity(sqlite);
  // RESIGN ONE-TIME (incidente owner 2026-06-12): i nodi firmati col vecchio
  // registry secret (FLOWFORGE_INTERNAL_TOKEN effimero, cambiato a un recreate)
  // hanno signature_mismatch e venivano bloccati ("Unknown node def"). Ora il
  // secret è STABILE (da SSO_SECRET) → ri-firmiamo UNA VOLTA col secret corrente
  // i nodi con sorgenti integri (digest valido). Vedi resignCustomNodesWithStableSecret.
  resignCustomNodesWithStableSecret(sqlite);

  // Draft / autosave separation (25 mag 2026) — il salvataggio automatico
  // NON sovrascrive più `nodes_json`/`edges_json` (= versione "ufficiale"
  // usata dall'engine al run). Scrive invece su `draft_json` (snapshot
  // completo del workflow in modifica). Il runtime engine NON guarda
  // `draft_json` mai → l'utente può sperimentare in editor senza rompere
  // l'esecuzione corrente. Una MANUAL save (PUT /workflows/:id) promuove
  // `draft_json` a `nodes_json`/`edges_json` e azzera il draft. Una
  // POST /discard-draft butta solo il draft (l'editor ricarica
  // dall'ultima manual save).
  //
  // Schema del JSON di draft_json (snapshot completo):
  //   { name, description, enabled, schemaVersion, nodes[], edges[],
  //     nodeDefs[], tags?, folderId?, onError?, concurrencyLimit?,
  //     breakpoints? }
  ensureColumn(sqlite, 'workflows', 'draft_json', 'TEXT');
  ensureColumn(sqlite, 'workflows', 'draft_updated_at', 'TEXT');

  // E4 (2026-06-06) — Error workflow wiring:
  // workflows.error_workflow_id = altro workflow del tenant che viene
  // triggerato in fan-out quando QUESTO workflow termina in error. Pattern
  // n8n errorWorkflow. Payload: { failedNodeId, error, runId, workflowId,
  // triggerInput, attempt }. NULL = no fallback (default).
  ensureColumn(sqlite, 'workflows', 'error_workflow_id', 'TEXT');

  // ─── Client Portal extension (2026-05-29) ───────────────────────────
  // viewer_share_tokens: estensione per supportare modalita\` portal cliente.
  //  - mode='readonly'  → comportamento storico (solo lettura dashboard)
  //  - mode='portal'    → portale cliente: lista workflow filtrabili +
  //                       bottone "Esegui ora" + cronologia + canvas
  //                       live read-only. Filtraggio + gating delle
  //                       azioni configurato in permissions_json.
  // permissions_json (jsonb-like):
  //   {
  //     "workflowTags": ["client-facing"]?,   // se presente, mostra solo
  //                                            // workflow con questi tag
  //     "workflowIds":  ["wf-1", "wf-2"]?,    // alternativa esplicita
  //     "allowRun":      true,                // bottone "Esegui ora"
  //     "allowedTriggerTypes": ["trigger_manual"]?, // gate run a questi
  //     "showHistory":   true,                // tab cronologia
  //     "showLiveCanvas": true,               // canvas animato live
  //     "brandName":     "Acme Srl"?,         // override brand
  //     "brandLogoUrl":  "https://..."?       // override logo
  //   }
  // NULL = default backward-compatible (readonly).
  ensureColumn(sqlite, 'viewer_share_tokens', 'mode', "TEXT NOT NULL DEFAULT 'readonly'");
  ensureColumn(sqlite, 'viewer_share_tokens', 'permissions_json', 'TEXT');

  // ux_events — opt-in UX telemetry. Captures milestone moments in the
  // editor (workflow_created_empty, node_added_unconfigured, run_blocked,
  // welcome_dismissed, tour_completed, etc.) so we can identify stuck users
  // and friction points BEFORE they vent on WhatsApp. NO PII collected.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ux_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      event_type TEXT NOT NULL,
      workflow_id TEXT,
      node_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS ux_events_tenant_idx ON ux_events(tenant_id);
    CREATE INDEX IF NOT EXISTS ux_events_type_idx ON ux_events(event_type);
    CREATE INDEX IF NOT EXISTS ux_events_created_idx ON ux_events(created_at);
  `);

  // workflow_locks — Tier 1 multi-user (#7): lock pessimistico di editing.
  // Un solo utente edita un workflow per volta; gli altri lo vedono read-only.
  // `heartbeat_at` (epoch ms) tiene il lock vivo: se chi lo detiene smette di
  // mandare heartbeat (tab chiusa, crash) il lock scade (LOCK_TTL_MS) e un altro
  // utente può fare takeover → niente lock orfani che bloccano per sempre.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_locks (
      workflow_id  TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      user_name    TEXT NOT NULL,
      acquired_at  INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
  `);

  // workflow_comments — Tier 3 multi-user (#7): commenti su nodi + @mentions +
  // activity feed. node_id NULL = commento generale sul workflow. mentions_json =
  // array di id mentionati (per le notifiche). resolved per chiudere i thread.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workflow_comments (
      id            TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      node_id       TEXT,
      user_id       TEXT NOT NULL,
      user_name     TEXT NOT NULL,
      body          TEXT NOT NULL,
      mentions_json TEXT,
      resolved      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS workflow_comments_wf_idx ON workflow_comments(workflow_id);
    CREATE INDEX IF NOT EXISTS workflow_comments_node_idx ON workflow_comments(workflow_id, node_id);
  `);

  // notifications — Tier 3 (#7): notifiche in-app (push @mention). Persistite
  // per il destinatario (user_id), consegnate al bell con polling. `read` per
  // segnare lette. Una @mention in un commento → una notifica per utente risolto.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      workflow_id TEXT,
      node_id     TEXT,
      actor_name  TEXT NOT NULL,
      preview     TEXT NOT NULL,
      read        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, read);
  `);

  // ai_interactions — opt-in training-set capture for AI Assistant calls.
  //
  // Why this exists: to fine-tune a FlowForge-specific LoRA (e.g. on top of
  // Liara/Qwen3), we need ≥ 1k high-quality (prompt, response, outcome)
  // triples grounded in real user behavior. We capture them HERE, locally,
  // because the upstream LLM providers (Anthropic, OpenAI, Liara) do not
  // retain conversations for us.
  //
  // Privacy: all prompt/response text is PII-redacted before insert by the
  // PIIRedactor service. The original (unredacted) text is NEVER persisted.
  // Retention is bounded by `retention_until` (default 90 days) and swept
  // by a daily cron job. Per-tenant opt-out is enforced at the service layer.
  //
  // Outcome tracking is the most valuable signal: we link each AI proposal
  // to the user's acceptance (accepted | rejected | edited) and, when a
  // patch was applied, to the resulting run's success/error. This makes the
  // training data "preference-labeled" (RLHF-grade) rather than just raw
  // interactions, which is a 10x quality boost for the final model.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      workflow_id TEXT,
      interaction_type TEXT NOT NULL,           -- 'editor_chat' | 'run_explain' | 'node_generate' | 'workflow_from_text'
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

      -- Input (after PII redaction)
      prompt TEXT NOT NULL,
      workflow_snapshot_json TEXT,              -- workflow state at request time (redacted)
      conversation_history_json TEXT,            -- multi-turn history (redacted)

      -- Output
      response_message TEXT NOT NULL,
      response_patch_json TEXT,                  -- proposed JSON patch when applicable
      response_model TEXT NOT NULL,              -- 'anthropic/claude-sonnet-4-5', 'liara/nha-v1', ...
      response_latency_ms INTEGER NOT NULL,
      response_tokens_in INTEGER,
      response_tokens_out INTEGER,

      -- Outcome (filled later, when user reacts)
      outcome TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected | edited | ignored | failed
      outcome_at TEXT,
      outcome_patch_applied_json TEXT,           -- user-modified patch (if outcome='edited')
      outcome_followup_run_id TEXT,              -- run id that the patch produced (if any)
      outcome_followup_run_status TEXT,          -- success | error | partial — derived from runs.status

      -- Quality (manual review)
      quality_score INTEGER,                     -- 0-5, NULL = not reviewed
      reviewer_user_id TEXT,
      reviewer_notes TEXT,

      -- Privacy
      pii_redacted INTEGER NOT NULL DEFAULT 1,
      pii_classes_json TEXT,                     -- ["email","cf","piva",...]
      retention_until TEXT NOT NULL,             -- ISO timestamp — sweep job deletes after

      -- Training split assignment (only after manual review)
      training_split TEXT                         -- 'train' | 'val' | 'test' | 'excluded' | NULL
    );
    CREATE INDEX IF NOT EXISTS ai_interactions_tenant_idx ON ai_interactions(tenant_id);
    CREATE INDEX IF NOT EXISTS ai_interactions_type_idx ON ai_interactions(interaction_type);
    CREATE INDEX IF NOT EXISTS ai_interactions_outcome_idx ON ai_interactions(outcome);
    CREATE INDEX IF NOT EXISTS ai_interactions_created_idx ON ai_interactions(created_at);
    CREATE INDEX IF NOT EXISTS ai_interactions_retention_idx ON ai_interactions(retention_until);
    CREATE INDEX IF NOT EXISTS ai_interactions_workflow_idx ON ai_interactions(workflow_id);
  `);

  // ai_training_settings — per-tenant opt-in/out toggle for AI Assistant
  // training-data capture (Track B = testo grezzo prompt/risposta PII-redatto).
  // ⚖️ DEFAULT OFF (opt-in): per il GDPR il consenso dev'essere esplicito e NON
  // pre-spuntato (CGUE Planet49) — riutilizzare prompt che possono contenere PII
  // (anche di terzi) per addestrare il modello richiede una base giuridica.
  // L'admin abilita esplicitamente; `consent_at` + `consent_by_user_id`
  // tengono la prova del consenso (accountability art.7 GDPR). Il segnale
  // aggregato NON-personale (Track A) è invece sempre attivo, tabella ai_signals.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_training_settings (
      tenant_id TEXT PRIMARY KEY,
      capture_enabled INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 90,
      consent_at TEXT,
      consent_by_user_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  // DB esistenti: aggiunge le colonne consenso se mancanti (idempotente).
  ensureColumn(sqlite, 'ai_training_settings', 'consent_at', 'TEXT');
  ensureColumn(sqlite, 'ai_training_settings', 'consent_by_user_id', 'TEXT');

  // ai_signals — Track A: segnale AGGREGATO/STRUTTURALE non-personale, SEMPRE
  // attivo (nessun consenso necessario). ⚖️ Per restare fuori dal GDPR qui NON
  // entra MAI testo libero, PII o quasi-identificatori: solo metadati operativi
  // (tipo interazione, nodeDef proposto, modello, latenza, token, esito,
  // quality). È l'invariante blindata dal guard `ai-signals-no-freetext`. Questa
  // tabella alimenta analytics + segnale RLHF aggregato senza toccare i prompt.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_signals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      interaction_type TEXT NOT NULL,          -- editor_chat | run_explain | node_generate | workflow_from_text
      node_def_id TEXT,                         -- nodeDef proposto (strutturale), o NULL
      response_model TEXT NOT NULL,             -- 'anthropic/claude-...', 'liara/nha-v1', ...
      response_latency_ms INTEGER NOT NULL,
      response_tokens_in INTEGER,
      response_tokens_out INTEGER,
      outcome TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected | edited | ignored | failed
      outcome_at TEXT,
      quality_score INTEGER,                    -- 0-5 dalla review (aggregato), o NULL
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS ai_signals_tenant_idx ON ai_signals(tenant_id);
    CREATE INDEX IF NOT EXISTS ai_signals_type_idx ON ai_signals(interaction_type);
    CREATE INDEX IF NOT EXISTS ai_signals_outcome_idx ON ai_signals(outcome);
    CREATE INDEX IF NOT EXISTS ai_signals_created_idx ON ai_signals(created_at);
  `);

  // error_outbox — outbox DUREVOLE della notifica di errore (at-least-once,
  // per-canale, dead-letter). DDL single-source-of-truth condivisa coi test.
  sqlite.exec(ERROR_OUTBOX_DDL);

  // imap_state — persistent UID cursor + processed-message dedup for the
  // trigger_imap watcher. Without this, every server restart re-processes
  // every email in the mailbox (in-memory `lastUidSeen=0`). With it:
  //   • last_uid_seen survives restarts → only new emails fire
  //   • processed_message_id idx → at-most-once delivery even if the IMAP
  //     server re-emits the same UID (rare, but happens on mailbox compaction)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS imap_state (
      workflow_id TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      last_uid_seen INTEGER NOT NULL DEFAULT 0,
      last_poll_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (workflow_id, mailbox)
    );
    CREATE TABLE IF NOT EXISTS imap_processed_messages (
      workflow_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      uid INTEGER NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (workflow_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS imap_processed_workflow_idx ON imap_processed_messages(workflow_id);
    CREATE INDEX IF NOT EXISTS imap_processed_at_idx ON imap_processed_messages(processed_at);
  `);

  // odoo_state — persistent record-id cursor for the trigger_odoo_polling
  // watcher. Mirrors `imap_state`: without it, every server restart would
  // re-fire every existing Odoo record. With it:
  //   • last_id_seen survives restarts → only new records fire
  //   • model is part of the PK so a single workflow can in theory have
  //     multiple triggers on different models (one row per model)
  //   • last_error makes failures observable from a single SQL probe
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS odoo_state (
      workflow_id TEXT NOT NULL,
      model TEXT NOT NULL,
      last_id_seen INTEGER NOT NULL DEFAULT 0,
      last_poll_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (workflow_id, model)
    );
  `);

  // AUDIT FIX WE-15 (2026-06-09 MEDIUM): poison-pill DLQ per Odoo poller.
  //
  // Pre-fix: se un record id N causava errore CONSISTENT nel dispatch del
  // workflow (es. JSON parse fail, validator zod throw, null check), il
  // poll loop faceva `break` lasciando `lastIdSeen = N-1`. Al prossimo tick
  // riprovava lo stesso id N → stesso errore → infinite stall. Tutto il
  // tenant Odoo bloccato finché operatore manuale.
  //
  // Post-fix: tabella DLQ + retry counter. Dopo `MAX_RETRY=5` fail consecutivi
  // sullo stesso record id, sposta in DLQ (INSERT row con error_message +
  // record_json) e BUMP `lastIdSeen=N` per sbloccare il flusso. Operatore
  // può revisionare in DLQ + replay (admin endpoint, fuori scope WE-15 base).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS odoo_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      model TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      record_json TEXT,
      error_message TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 1,
      first_failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      dlqd_at TEXT,
      replayed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS odoo_dlq_workflow_idx ON odoo_dlq(workflow_id, model);
    CREATE INDEX IF NOT EXISTS odoo_dlq_record_idx ON odoo_dlq(workflow_id, model, record_id);
  `);

  // tenant_ai_preferences — per-tenant AI provider preferences (separate from
  // training capture). Today: only allow_liara, but designed for future
  // additions (preferred_default_provider, disabled_providers list, etc).
  //
  // Liara on/off is bi-level:
  //   • Global env FLOWFORGE_DISABLE_LIARA=true   → off for ALL tenants on this instance
  //   • Per-tenant allow_liara=0                  → off for this tenant only
  //   • Effective state = global_enabled AND tenant_allowed
  // This lets a SaaS multi-tenant operator keep Liara as default but allow
  // a specific GDPR-strict customer to exclude it for their tenant.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_ai_preferences (
      tenant_id TEXT PRIMARY KEY,
      allow_liara INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  // 2026-06-07: default_llm_provider — l'utente in Settings sceglie il provider
  // che TUTTI gli `agent_*` nei workflow scaffold-generati useranno per default.
  // Senza questo campo Liara guessava (gpt-4o random) ignorando il fatto che il
  // tenant non ha quella chiave. Source-of-truth: questa colonna.
  //   null     = scegli automatico (primo configurato, fallback liara)
  //   'liara'  = sempre liara (anche se altri provider sono configurati)
  //   'openai' = scaffold deve sempre usare openai
  //   ecc.
  ensureColumn(sqlite, 'tenant_ai_preferences', 'default_llm_provider', 'TEXT');

  // ai_chat_sessions / ai_chat_messages — memoria conversazionale persistente
  // per Help Chat AI, AI Scaffold, e qualunque future LLM surface che
  // necessita di multi-turn cross-sessione. Tenant isolation:
  // ogni sessione ha tenant_id e user_id; le query frontend sono confinate
  // al tenant del caller via getTenantId(). I superadmin POSSONO interrogare
  // cross-tenant via endpoint dedicato /admin/ai-chat/sessions per audit.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      surface     TEXT NOT NULL,
      title       TEXT,
      workflow_id TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS ai_chat_sessions_tenant_idx ON ai_chat_sessions(tenant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS ai_chat_sessions_user_idx ON ai_chat_sessions(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      tokens      INTEGER,
      model       TEXT,
      ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS ai_chat_messages_session_idx ON ai_chat_messages(session_id, id);
  `);

  // Phase 4 — multimodal attachments per ai_chat_messages.
  // `attachments_json` contiene array di { kind, name, mimeType,
  // dataBase64?, url?, extractedText? }. Memorizzato come JSON inline
  // (no separate table): i payload sono request-bounded (max ~5MB/msg).
  // ALTER TABLE idempotente — silenzia se la colonna esiste già.
  try {
    sqlite.exec(`ALTER TABLE ai_chat_messages ADD COLUMN attachments_json TEXT`);
  } catch { /* column already exists — idempotente */ }

  // ───────────────────────────────────────────────────────────────────
  // Phase 5 — TENANTS first-class entity (enterprise-grade)
  //
  // Prima di Phase 5 i tenant erano "soft": stringa libera su ogni tabella,
  // niente lifecycle, niente status (trial/active/suspended), niente
  // legal_name/P.IVA/billing, niente quota enforcement. Design da junior
  // dev, inaccettabile per prodotto enterprise on-premise venduto a
  // clienti con SLA + audit + GDPR.
  //
  // Schema:
  //   • id (UUID slug, lowercased) — è anche il tenant_id usato come FK soft
  //     in tutte le altre tabelle (compat con codice esistente)
  //   • Identità legale: display_name, legal_name, vat_number (P.IVA), tax_code
  //   • Billing: billing_email, billing_address, country, locale, timezone
  //   • Lifecycle: status (trial|active|suspended|archived), trial_ends_at,
  //     suspended_at, suspended_reason, archived_at
  //   • Commercial: plan (trial|starter|pro|enterprise), subscription_ref
  //   • Quote: max_workflows, max_runs_per_month, max_storage_mb (0=unlimited)
  //   • Settings JSON (config tenant-specifico estensibile senza migration)
  //   • Hierarchy: parent_tenant_id (sub-tenant per multi-org)
  //   • Audit: created_at, updated_at, created_by_user_id
  //   • Soft delete: deleted_at (GDPR-compliant, non DROP fisico)
  //
  // BACKFILL: per ogni tenant_id distinct in users/workflows, INSERT con
  //   status='active', plan='enterprise' (no downgrade dell'esistente).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id                  TEXT PRIMARY KEY,
      display_name        TEXT NOT NULL,
      legal_name          TEXT,
      vat_number          TEXT,
      tax_code            TEXT,
      billing_email       TEXT,
      billing_address     TEXT,
      country             TEXT NOT NULL DEFAULT 'IT',
      locale              TEXT NOT NULL DEFAULT 'it',
      timezone            TEXT NOT NULL DEFAULT 'Europe/Rome',
      status              TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('trial', 'active', 'suspended', 'archived')),
      trial_ends_at       TEXT,
      suspended_at        TEXT,
      suspended_reason    TEXT,
      archived_at         TEXT,
      plan                TEXT NOT NULL DEFAULT 'enterprise'
                          CHECK (plan IN ('trial', 'free', 'starter', 'pro', 'business', 'team', 'enterprise')),
      subscription_ref    TEXT,
      max_workflows       INTEGER NOT NULL DEFAULT 0,
      max_runs_per_month  INTEGER NOT NULL DEFAULT 0,
      max_storage_mb      INTEGER NOT NULL DEFAULT 0,
      settings_json       TEXT NOT NULL DEFAULT '{}',
      parent_tenant_id    TEXT,
      created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_by_user_id  TEXT,
      deleted_at          TEXT,
      FOREIGN KEY (parent_tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS tenants_plan_idx ON tenants(plan) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS tenants_vat_unique ON tenants(vat_number)
      WHERE vat_number IS NOT NULL AND deleted_at IS NULL;
  `);

  // ── Migration 2026-05-31 (fix 2026-06-01): extend plan CHECK constraint
  // con 'free' e 'business'. SQLite NON supporta ALTER COLUMN CHECK.
  // better-sqlite3 blocca UPDATE sqlite_master anche con writable_schema=1
  // (safety wrapper nativo). Soluzione: table rebuild dinamico (rename →
  // create new → copy → drop → rename + ricrea indici).
  const checkRow = sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='tenants'
  `).get() as { sql: string } | undefined;
  if (checkRow && !checkRow.sql.includes("'free'")) {
    const oldSql = checkRow.sql;
    const newTableSql = oldSql
      .replace(/CREATE TABLE\s+["']?tenants["']?/i, 'CREATE TABLE tenants_new')
      .replace(
        /'trial',\s*'starter',\s*'pro',\s*'enterprise'/,
        "'trial', 'free', 'starter', 'pro', 'business', 'team', 'enterprise'",
      );
    sqlite.exec('PRAGMA foreign_keys=OFF');
    try {
      sqlite.exec(newTableSql);
      sqlite.exec('INSERT INTO tenants_new SELECT * FROM tenants');
      sqlite.exec('DROP TABLE tenants');
      sqlite.exec('ALTER TABLE tenants_new RENAME TO tenants');
      // Ricrea indici (sono stati droppati con la tabella)
      sqlite.exec(`CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status) WHERE deleted_at IS NULL`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS tenants_plan_idx ON tenants(plan) WHERE deleted_at IS NULL`);
      sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_vat_unique ON tenants(vat_number) WHERE vat_number IS NOT NULL AND deleted_at IS NULL`);
    } finally {
      sqlite.exec('PRAGMA foreign_keys=ON');
    }
  }

  // ── Migration 2026-06-13: estende il CHECK di ai_conversations.surface con
  // 'node_editor' e 'db_studio' (contesto cross-surface: node/db produttori).
  // Stesso pattern table-rebuild della migration tenants sopra (SQLite non
  // supporta ALTER su CHECK). Idempotente: rebuilda solo se manca 'node_editor'.
  const aiConvRow = sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_conversations'
  `).get() as { sql: string } | undefined;
  if (aiConvRow && !aiConvRow.sql.includes("'node_editor'")) {
    const newTableSql = aiConvRow.sql
      .replace(/CREATE TABLE\s+["']?ai_conversations["']?/i, 'CREATE TABLE ai_conversations_new')
      .replace(
        /surface\s+TEXT\s+NOT NULL\s+CHECK\s*\(\s*surface IN \([^)]*\)\s*\)/i,
        "surface TEXT NOT NULL CHECK (surface IN ('editor_chat', 'wizard_scaffold', 'help_chat', 'node_editor', 'db_studio'))",
      );
    sqlite.exec('PRAGMA foreign_keys=OFF');
    try {
      sqlite.exec(newTableSql);
      sqlite.exec('INSERT INTO ai_conversations_new SELECT * FROM ai_conversations');
      sqlite.exec('DROP TABLE ai_conversations');
      sqlite.exec('ALTER TABLE ai_conversations_new RENAME TO ai_conversations');
      // Ricrea gli indici (droppati con la tabella).
      sqlite.exec(`CREATE INDEX IF NOT EXISTS ai_conv_user_idx ON ai_conversations(user_id, last_message_at DESC) WHERE deleted_at IS NULL`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS ai_conv_workspace_idx ON ai_conversations(workspace_id, last_message_at DESC) WHERE workspace_id IS NOT NULL AND deleted_at IS NULL`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS ai_conv_surface_idx ON ai_conversations(user_id, surface, last_message_at DESC) WHERE deleted_at IS NULL`);
      sqlite.exec(`CREATE INDEX IF NOT EXISTS ai_conv_deleted_purge_idx ON ai_conversations(deleted_at) WHERE deleted_at IS NOT NULL`);
    } finally {
      sqlite.exec('PRAGMA foreign_keys=ON');
    }
  }

  // BACKFILL: per ogni tenant_id distinct trovato in users + workflows,
  // crea il record tenants con status='active' se non esiste. Pattern
  // idempotente — riesegui senza danni.
  const distinctTenants = sqlite.prepare(`
    SELECT DISTINCT tenant_id FROM (
      SELECT tenant_id FROM users WHERE tenant_id IS NOT NULL
      UNION
      SELECT tenant_id FROM workflows WHERE tenant_id IS NOT NULL
    ) ORDER BY tenant_id
  `).all() as { tenant_id: string }[];
  const insertTenant = sqlite.prepare(`
    INSERT OR IGNORE INTO tenants (id, display_name, status, plan, country, locale, timezone)
    VALUES (?, ?, 'active', 'enterprise', 'IT', 'it', 'Europe/Rome')
  `);
  for (const row of distinctTenants) {
    if (!row.tenant_id) continue;
    // Display name = title-cased slug come default. L'admin lo aggiorna dopo
    // dalla UI con i dati legali veri.
    const displayName = row.tenant_id.charAt(0).toUpperCase() + row.tenant_id.slice(1);
    insertTenant.run(row.tenant_id, displayName);
  }
  // Garanzia: il tenant 'default' DEVE esistere (è il fallback di tutto il sistema)
  insertTenant.run('default', 'Default Tenant');

  // FIX 2026-05-31 (enforcement piani v2): sync tenant quota da env Docker.
  // Il portal inietta FLOWFORGE_TENANT_ID + FLOWFORGE_PLAN_CODE + FLOWFORGE_MAX_WORKFLOWS
  // via buildEnv() su provision/onboard. Qui aggiorna il record tenants locale per
  // garantire che `tenantService.checkQuota` legga limiti veri del piano corrente.
  // NULL/'' = unlimited (Enterprise) → max_workflows = 999999 magic finche\` lo
  // schema runtime non supporta NULL nativamente.
  const tenantIdEnv = process.env.FLOWFORGE_TENANT_ID;
  const planCodeEnv = process.env.FLOWFORGE_PLAN_CODE;
  const maxWfRaw = process.env.FLOWFORGE_MAX_WORKFLOWS;
  if (tenantIdEnv) {
    const maxWf = (maxWfRaw === undefined || maxWfRaw === '') ? 999999 : parseInt(maxWfRaw, 10);
    if (!isNaN(maxWf) && maxWf > 0) {
      // INSERT OR IGNORE prima (per crearlo se non esiste), poi UPDATE per sync valori env.
      insertTenant.run(tenantIdEnv, tenantIdEnv.slice(0, 8));
      sqlite.prepare(`
        UPDATE tenants
        SET max_workflows = ?, plan = COALESCE(?, plan)
        WHERE id = ?
      `).run(maxWf, planCodeEnv ?? null, tenantIdEnv);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Janitor — Data Quality Self-Healing tables
  //
  // Tre tabelle interne al system DB:
  //   • janitor_locks       — lock distribuito named-per-regola con TTL
  //   • janitor_rule_configs — config UI-driven per ogni (rule_id, tenant_id)
  //   • janitor_run_log     — log esiti esecuzione (audit + UI history)
  //   • janitor_dsl_rules   — DSL rules definite via UI dal tenant
  //
  // Le quarantine table vere e proprie (`quarantined_rows`) vivono sul
  // data source target — sono create automaticamente da
  // QuarantineGatewayAdapter via applyMigration cross-DB al primo bisogno.
  // ───────────────────────────────────────────────────────────────────
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS janitor_locks (
      rule_id      TEXT PRIMARY KEY,
      held_by      TEXT NOT NULL,
      acquired_at  TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS janitor_locks_expires_idx ON janitor_locks(expires_at);

    CREATE TABLE IF NOT EXISTS janitor_rule_configs (
      rule_id              TEXT NOT NULL,
      tenant_id            TEXT NOT NULL DEFAULT 'default',
      enabled              INTEGER NOT NULL DEFAULT 1,
      schedule             TEXT NOT NULL,
      data_source_ref      TEXT NOT NULL,
      max_rows_per_run     INTEGER NOT NULL,
      severity             TEXT NOT NULL CHECK (severity IN ('critical','warning')),
      params_json          TEXT NOT NULL DEFAULT '{}',
      notify_on_detection  INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT NOT NULL,
      updated_by           TEXT,
      PRIMARY KEY (rule_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS janitor_rule_configs_tenant_idx ON janitor_rule_configs(tenant_id);

    CREATE TABLE IF NOT EXISTS janitor_run_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id          TEXT NOT NULL,
      rule_id           TEXT NOT NULL,
      tenant_id         TEXT NOT NULL DEFAULT 'default',
      data_source_ref   TEXT NOT NULL,
      target_table      TEXT NOT NULL,
      started_at        TEXT NOT NULL,
      ended_at          TEXT NOT NULL,
      duration_ms       INTEGER NOT NULL,
      rows_detected     INTEGER NOT NULL DEFAULT 0,
      rows_repaired     INTEGER NOT NULL DEFAULT 0,
      rows_quarantined  INTEGER NOT NULL DEFAULT 0,
      rows_skipped      INTEGER NOT NULL DEFAULT 0,
      critical_count    INTEGER NOT NULL DEFAULT 0,
      warning_count     INTEGER NOT NULL DEFAULT 0,
      dry_run           INTEGER NOT NULL DEFAULT 0,
      success           INTEGER NOT NULL,
      error_message     TEXT,
      triggered_by      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS janitor_run_log_cycle_idx   ON janitor_run_log(cycle_id);
    CREATE INDEX IF NOT EXISTS janitor_run_log_rule_idx    ON janitor_run_log(rule_id);
    CREATE INDEX IF NOT EXISTS janitor_run_log_tenant_idx  ON janitor_run_log(tenant_id);
    CREATE INDEX IF NOT EXISTS janitor_run_log_started_idx ON janitor_run_log(started_at);

    CREATE TABLE IF NOT EXISTS janitor_dsl_rules (
      id                       TEXT PRIMARY KEY,
      tenant_id                TEXT NOT NULL,
      title                    TEXT NOT NULL,
      description              TEXT NOT NULL DEFAULT '',
      data_source_ref          TEXT NOT NULL,
      target_table             TEXT NOT NULL,
      target_pk_column         TEXT NOT NULL,
      detect_sql               TEXT NOT NULL,
      repair_sql               TEXT,
      placeholders_json        TEXT NOT NULL DEFAULT '{}',
      tags_json                TEXT NOT NULL DEFAULT '[]',
      default_severity         TEXT NOT NULL CHECK (default_severity IN ('critical','warning')),
      default_schedule         TEXT NOT NULL,
      default_max_rows_per_run INTEGER NOT NULL,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      created_by               TEXT
    );
    CREATE INDEX IF NOT EXISTS janitor_dsl_rules_tenant_idx ON janitor_dsl_rules(tenant_id);
  `);

  // ───────────────────────────────────────────────────────────────────
  // Tenant integrations — credentials for 3rd-party providers
  //
  // Two tables:
  //   • tenant_integrations         — encrypted credentials (Gmail OAuth tokens,
  //                                   WhatsApp access tokens, Stripe API keys,
  //                                   Google Drive OAuth tokens, etc.). Tenant-
  //                                   scoped HKDF-derived AES-256-GCM via
  //                                   `lib/secrets-crypto.ts`.
  //   • integration_webhook_events  — inbound webhook dedup + audit (Stripe
  //                                   `payment_intent.succeeded`, WhatsApp
  //                                   `messages.read` etc.). UNIQUE on
  //                                   event_id_external prevents double-
  //                                   processing on provider retries.
  //
  // Naming key for SELECT: (tenant_id, provider, label). `label` lets a tenant
  // have multiple instances of the same provider (e.g. two Gmail mailboxes,
  // 'sales@' and 'support@'). When NULL, treated as the default instance.
  //
  // Encryption: ciphertext+nonce stored as BLOBs. The auth tag is appended to
  // ciphertext (last 16 bytes — see secrets-crypto.ts for layout).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_integrations (
      id                   TEXT PRIMARY KEY,
      provider             TEXT NOT NULL
                           CHECK (provider IN (
                             'gmail', 'whatsapp', 'stripe',
                             'google_drive', 'ocr_tesseract', 'ocr_vision'
                           )),
      tenant_id            TEXT NOT NULL,
      label                TEXT,
      credentials_encrypted BLOB NOT NULL,
      credentials_nonce    BLOB NOT NULL,
      expires_at           INTEGER,
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_used_at         TEXT,
      created_by_user_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS tenant_integrations_tenant_provider_idx
      ON tenant_integrations(tenant_id, provider);
    -- Per-tenant UNIQUE on (provider, COALESCE(label,'')) — at most one
    -- "default" instance per provider per tenant, plus N labeled instances.
    CREATE UNIQUE INDEX IF NOT EXISTS tenant_integrations_tenant_provider_label_uniq
      ON tenant_integrations(tenant_id, provider, COALESCE(label, ''));

    CREATE TABLE IF NOT EXISTS integration_webhook_events (
      id                  TEXT PRIMARY KEY,
      provider            TEXT NOT NULL,
      tenant_id           TEXT NOT NULL,
      event_id_external   TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      payload_json        TEXT NOT NULL,
      received_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      processed_at        TEXT,
      signature_valid     INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS integration_webhook_events_external_uniq
      ON integration_webhook_events(provider, event_id_external);
    CREATE INDEX IF NOT EXISTS integration_webhook_events_tenant_idx
      ON integration_webhook_events(tenant_id, received_at DESC);

    -- ════════════════════════════════════════════════════════════════
    -- B2B CRM: leads, GDPR consents, interactions, orders.
    -- Created 2026-06-05. Used by the Lead Hunter / GDPR Consent /
    -- Commercial Pipeline / Reply Triage workflows. The interactions
    -- table is also the sink for the /api/track/{open,click}/:token
    -- HTTP endpoints — every pixel hit and link click lands here, and
    -- a downstream batch job rolls them up into lead-score deltas.
    -- ════════════════════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS b2b_leads (
      id                TEXT PRIMARY KEY,
      tenant_id         TEXT NOT NULL,
      ragione_sociale   TEXT NOT NULL,
      categoria         TEXT,                      -- enoteca | cocktail_bar | grossista | hotel | ristorante | …
      area              TEXT,                      -- regione/provincia/free-form
      email             TEXT,
      phone             TEXT,
      site              TEXT,
      address           TEXT,
      status            TEXT NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','consent_pending','consent_yes','consent_no','customer','inactive','blocked')),
      score             INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
      source            TEXT,                      -- google_maps | pagine_gialle | manual | import | …
      extra_json        TEXT,                      -- arbitrary JSON for source-specific fields
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_email_sent_at TEXT,
      consent_token     TEXT                       -- single-use HMAC for the consent-link landing
    );
    CREATE UNIQUE INDEX IF NOT EXISTS b2b_leads_tenant_email_uniq
      ON b2b_leads(tenant_id, LOWER(COALESCE(email,'')))
      WHERE email IS NOT NULL AND email <> '';
    CREATE INDEX IF NOT EXISTS b2b_leads_status_idx
      ON b2b_leads(tenant_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS b2b_leads_categoria_area_idx
      ON b2b_leads(tenant_id, categoria, area);

    CREATE TABLE IF NOT EXISTS b2b_gdpr_consents (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      lead_id         TEXT NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('granted','revoked')),
      method          TEXT NOT NULL CHECK (method IN ('email_link','form','whatsapp','manual','imported')),
      ip              TEXT,
      ua              TEXT,
      ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      payload_json    TEXT
    );
    CREATE INDEX IF NOT EXISTS b2b_gdpr_consents_lead_idx
      ON b2b_gdpr_consents(tenant_id, lead_id, ts DESC);

    CREATE TABLE IF NOT EXISTS b2b_interactions (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      lead_id         TEXT NOT NULL,
      campaign_id     TEXT,
      send_id         TEXT,
      type            TEXT NOT NULL CHECK (type IN (
                        'email_sent','email_open','email_click',
                        'email_reply','email_bounce','email_complaint',
                        'whatsapp_sent','whatsapp_reply','call','note','order'
                      )),
      payload_json    TEXT,
      ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS b2b_interactions_lead_ts_idx
      ON b2b_interactions(tenant_id, lead_id, ts DESC);
    CREATE INDEX IF NOT EXISTS b2b_interactions_campaign_idx
      ON b2b_interactions(tenant_id, campaign_id, type, ts DESC);
    CREATE INDEX IF NOT EXISTS b2b_interactions_send_idx
      ON b2b_interactions(send_id) WHERE send_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS b2b_orders (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      lead_id         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','confirmed','paid','shipped','delivered','cancelled','refunded')),
      products_json   TEXT,
      total_cents     INTEGER,
      currency        TEXT NOT NULL DEFAULT 'EUR',
      paypal_id       TEXT,
      paid_at         TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS b2b_orders_lead_idx
      ON b2b_orders(tenant_id, lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS b2b_orders_status_idx
      ON b2b_orders(tenant_id, status, updated_at DESC);
  `);

  logger.info({ backfilled: distinctTenants.length }, 'Migrations applied');
}

/**
 * Backfill ONE-TIME dell'integrità dei custom node legacy + flag enforcement.
 *
 * Perché serve: il loader blocca i nodi con record di integrità invalido, ma
 * un record ASSENTE era fail-open ("nodo legacy"). Un attaccante capace di
 * UPDATE sulla riga (il threat model della feature) poteva quindi azzerare le
 * colonne integrity_* e far eseguire i sorgenti manomessi dal percorso legacy.
 *
 * Soluzione: alla PRIMA boot con secret configurato, ogni nodo compilato senza
 * record viene firmato così com'è (trust-on-first-boot: i nodi esistenti sono
 * legittimi per definizione, sono stati creati dal flusso normale) e si setta
 * INTEGRITY_ENFORCED_FLAG in system_flags. Da quel momento il loader tratta
 * l'assenza del record su un nodo runnable come strip-attack → blocco.
 *
 * Il flag rende il backfill one-time PER DATABASE: ai boot successivi le righe
 * senza integrità NON vengono ri-firmate (ri-firmare = ri-fidarsi di qualunque
 * cosa ci sia nella riga, che annullerebbe la difesa). Idempotente, sync,
 * niente I/O di rete. Senza secret (dev/test) non fa nulla e non setta il flag.
 */
export function backfillCustomNodeIntegrity(sqlite: SqliteDb): void {
  const secret = registrySecret();
  if (!secret) return;

  const flag = sqlite.prepare(
    'SELECT value FROM system_flags WHERE key = ?',
  ).all(INTEGRITY_ENFORCED_FLAG) as { value: string }[];
  if (flag.length > 0) return; // enforcement già attivo: MAI ri-firmare

  const rows = sqlite.prepare(
    `SELECT id, slug, semver, source_executor, source_definition, source_schema, compiled_executor
       FROM custom_nodes
      WHERE integrity_digest IS NULL AND compiled_executor IS NOT NULL`,
  ).all() as {
    id: string;
    slug: string;
    semver: string;
    source_executor: string;
    source_definition: string;
    source_schema: string;
    compiled_executor: string;
  }[];

  const update = sqlite.prepare(
    `UPDATE custom_nodes SET integrity_digest = ?, integrity_signature = ?, integrity_algo = ?
      WHERE id = ?`,
  );
  for (const row of rows) {
    const integrity = makePackageIntegrity(
      {
        slug: row.slug,
        semver: row.semver,
        sourceExecutor: row.source_executor,
        sourceDefinition: row.source_definition,
        sourceSchema: row.source_schema,
        compiledExecutor: row.compiled_executor,
      },
      secret,
    );
    update.run(integrity.digest, integrity.signature, integrity.algo, row.id);
  }

  sqlite.prepare(
    `INSERT INTO system_flags (key, value) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO NOTHING`,
  ).run(INTEGRITY_ENFORCED_FLAG);

  logger.info(
    { backfilled: rows.length },
    '[custom-node] integrità backfillata sui nodi legacy — enforcement attivo (strip-attack bloccato dal loader)',
  );
}

/** Flag one-time del resign col registry secret stabile (post incidente 2026-06-12). */
const INTEGRITY_RESIGNED_FLAG = 'custom_nodes_resigned_stable_secret_v1';

/**
 * RESIGN ONE-TIME col registry secret STABILE.
 *
 * Incidente owner 2026-06-12: il registry secret derivava da
 * FLOWFORGE_INTERNAL_TOKEN (randomBytes per-container, cambiato a ogni recreate)
 * → le firme dei custom node diventavano `signature_mismatch` a ogni recreate →
 * nodi legittimi bloccati ("Unknown node def"). Reso stabile (registry-secret.ts,
 * da SSO_SECRET) → qui ri-firmiamo UNA VOLTA i nodi col secret corrente.
 *
 * SICUREZZA — ri-firmiamo SOLO se il DIGEST ricalcolato dai sorgenti reali ===
 * digest dichiarato (sorgenti integri rispetto alla firma precedente): è il
 * caso "signature stale, sorgenti non toccati" della rotazione. Se il digest
 * NON torna (sorgenti alterati / corruzione) NON ri-firmiamo → il loader
 * continua a bloccare (no certificazione di una manomissione). One-time via
 * flag (idempotente). Stesso trust-on-boot del backfill enforcement.
 */
export function resignCustomNodesWithStableSecret(sqlite: SqliteDb): void {
  const secret = registrySecret();
  if (!secret) return;
  const already = sqlite.prepare('SELECT 1 FROM system_flags WHERE key = ?').all(INTEGRITY_RESIGNED_FLAG);
  if (already.length > 0) return; // one-time

  const rows = sqlite.prepare(
    `SELECT id, slug, semver, source_executor, source_definition, source_schema, compiled_executor, integrity_digest
       FROM custom_nodes
      WHERE integrity_digest IS NOT NULL AND compiled_executor IS NOT NULL`,
  ).all() as {
    id: string; slug: string; semver: string;
    source_executor: string; source_definition: string; source_schema: string;
    compiled_executor: string; integrity_digest: string;
  }[];

  const update = sqlite.prepare(
    'UPDATE custom_nodes SET integrity_digest = ?, integrity_signature = ?, integrity_algo = ? WHERE id = ?',
  );
  let resigned = 0;
  let skippedTampered = 0;
  for (const row of rows) {
    const pkg = {
      slug: row.slug, semver: row.semver,
      sourceExecutor: row.source_executor, sourceDefinition: row.source_definition,
      sourceSchema: row.source_schema, compiledExecutor: row.compiled_executor,
    };
    // Ri-firma SOLO se i sorgenti sono integri rispetto al digest dichiarato
    // (rotazione del secret, non manomissione). Se il digest ricalcolato NON
    // torna → sorgenti alterati/corrotti → NON certifichiamo (il loader blocca).
    if (computePackageDigest(pkg) !== row.integrity_digest) {
      skippedTampered += 1;
      continue;
    }
    const fresh = makePackageIntegrity(pkg, secret);
    update.run(fresh.digest, fresh.signature, fresh.algo, row.id);
    resigned += 1;
  }

  sqlite.prepare(
    `INSERT INTO system_flags (key, value) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO NOTHING`,
  ).run(INTEGRITY_RESIGNED_FLAG);

  if (resigned > 0 || skippedTampered > 0) {
    logger.info(
      { resigned, skippedTampered },
      '[custom-node] resign one-time col registry secret stabile completato',
    );
  }
}

// CLI auto-trigger DISABILITATO: causava process.exit(0) spurio quando tsup
// bundla migrate + main in singolo file (import.meta.url === argv[1]).
// Per eseguire migrations standalone usa lo script package.json "db:migrate"
// che chiama esplicitamente `tsx src/storage/migrate.ts`.
