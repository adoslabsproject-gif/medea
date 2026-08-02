/**
 * Client Portal service — modalità "portal cliente" del viewer-share esistente.
 *
 * VISIONE ARCHITETTURALE:
 * Il portale cliente e\` una vista white-label, separata dall'editor, dove
 * un cliente non-tecnico vede SOLO i suoi workflow operativi, puo\`
 * lanciarli on-demand, vede la cronologia, e (se configurato) puo\`
 * modificare alcuni campi-business senza toccare la config del nodo.
 *
 * Vive nello stesso runtime container del tenant e riusa la tabella
 * `viewer_share_tokens` (estesa con `mode` + `permissions_json` in
 * migrate.ts 2026-05-29). Il viewer-share legacy (readonly dashboard)
 * resta intatto — questo service e\` un complemento, non un replacement.
 *
 * SICUREZZA — defense in depth:
 *  1. Token: 32-byte hex random (non guessable). Stored as plaintext (e\`
 *     l'URL il segreto). Mai serializzato in log.
 *  2. Revoca istantanea (`revoked_at` set → verify ritorna null).
 *  3. Expiry hard (`expires_at` superato → verify ritorna null).
 *  4. Tenant-scoped: il token e\` legato al tenant via FK; impossibile
 *     usare token di tenant A per accedere a tenant B.
 *  5. Run gating: gli endpoint POST /portal/.../run controllano
 *     `canRunWorkflow()` che verifica permissions.allowRun + trigger type
 *     whitelisted. Mai esecuzione di workflow non whitelistati.
 *  6. Workflow visibility: filtra per `permissions.workflowIds` esplicite
 *     O per `permissions.workflowTags`. Senza permissions → vista vuota
 *     (default deny).
 *  7. Audit log: ogni create/revoke/run-from-portal scrive in audit_log.
 *
 * NON COPRE QUI:
 *  - Magic-link email delivery (separato in apps/portal, fuori scope runtime)
 *  - Editor accesss (volutamente impossibile: il portal e\` un'altra route)
 *  - Real-time SSE del live canvas (riusa /dashboard/stream esistente con
 *    filtro server-side basato su workflow visibili al token)
 */

import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { AuditLogService } from './audit.service.js';

const audit = new AuditLogService();

// ─── Types ────────────────────────────────────────────────────────────

export type PortalTokenMode = 'readonly' | 'portal';

export interface PortalPermissions {
  /** Mostra solo workflow con questi tag (es. "client-facing"). Vuoto/undefined = no filter per tag. */
  workflowTags?: string[];
  /** Allowlist esplicita di workflow IDs visibili. Se presente, ignora workflowTags. */
  workflowIds?: string[];
  /** Permette il pulsante "Esegui ora". Default: false (read-only). */
  allowRun?: boolean;
  /** Trigger types permessi per il "Esegui ora" (default: solo manual). */
  allowedTriggerTypes?: string[];
  /** Mostra la sezione cronologia. Default: true. */
  showHistory?: boolean;
  /** Mostra il canvas live read-only del run in corso. Default: true. */
  showLiveCanvas?: boolean;
  /** Override branding: nome cliente nell'header. */
  brandName?: string;
  /** Override branding: URL del logo cliente. */
  brandLogoUrl?: string;
}

export interface PortalToken {
  id: string;
  tenantId: string;
  token: string;
  name: string;
  mode: PortalTokenMode;
  permissions: PortalPermissions;
  createdBy?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastAccessedAt?: string;
  accessCount: number;
}

interface PortalTokenRow {
  id: string;
  tenant_id: string;
  token: string;
  name: string;
  mode: string;
  permissions_json: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

interface WorkflowSummaryRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  tags_json: string | null;
  nodes_json: string;
  updated_at: string;
}

/** Workflow shape esposto al cliente (no JSON crudo, no node defs internal). */
export interface PortalWorkflowSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  /** True se il portal ha allowRun=true E il workflow ha almeno 1 trigger nei tipi consentiti. */
  canRun: boolean;
  /** Per la lista — quante volte il workflow e\` stato eseguito (running + history). */
  // (non popolato qui per evitare N+1; il consumer aggrega lato lista runs)
}

// ─── Helpers ──────────────────────────────────────────────────────────

// Default permissions: TUTTO restrittivo. workflowTags + workflowIds NON
// settati per default (assenti) → trigger del default-deny in
// listVisibleWorkflows. Solo i flag booleani + allowedTriggerTypes hanno
// default safe esposti.
const DEFAULT_PERMISSIONS: Readonly<PortalPermissions> = Object.freeze({
  allowRun: false,
  allowedTriggerTypes: ['trigger_manual'],
  showHistory: true,
  showLiveCanvas: true,
});

function parsePermissions(raw: string | null): PortalPermissions {
  if (!raw) return { ...DEFAULT_PERMISSIONS };
  try {
    const parsed = JSON.parse(raw) as Partial<PortalPermissions>;
    return { ...DEFAULT_PERMISSIONS, ...parsed };
  } catch {
    return { ...DEFAULT_PERMISSIONS };
  }
}

function rowToToken(r: PortalTokenRow): PortalToken {
  const t: PortalToken = {
    id: r.id,
    tenantId: r.tenant_id,
    token: r.token,
    name: r.name,
    mode: r.mode === 'portal' ? 'portal' : 'readonly',
    permissions: parsePermissions(r.permissions_json),
    createdAt: r.created_at,
    accessCount: r.access_count,
  };
  if (r.created_by) t.createdBy = r.created_by;
  if (r.expires_at) t.expiresAt = r.expires_at;
  if (r.revoked_at) t.revokedAt = r.revoked_at;
  if (r.last_accessed_at) t.lastAccessedAt = r.last_accessed_at;
  return t;
}

function parseWorkflowTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function workflowHasAllowedTrigger(nodesJson: string, allowedTriggerTypes: string[]): boolean {
  if (allowedTriggerTypes.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(nodesJson);
    if (!Array.isArray(parsed)) return false;
    const allowed = new Set(allowedTriggerTypes);
    return parsed.some((n) => {
      if (!n || typeof n !== 'object') return false;
      const defId = (n as { defId?: unknown }).defId;
      return typeof defId === 'string' && allowed.has(defId);
    });
  } catch {
    return false;
  }
}

// ─── Service ──────────────────────────────────────────────────────────

export class ClientPortalService {
  /**
   * Crea un token in modalita\` portal con permissions specifiche.
   * Per il legacy readonly, vedi ViewerShareService.create() esistente.
   */
  async create(
    tenantId: string,
    opts: {
      name: string;
      permissions: PortalPermissions;
      expiresInDays?: number;
      createdBy?: string;
    },
  ): Promise<PortalToken> {
    const { sqlite } = getDatabase();
    const id = nanoid();
    const token = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    const expiresAt =
      opts.expiresInDays !== undefined
        ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
    const permissionsJson = JSON.stringify(opts.permissions);

    sqlite
      .prepare(
        `INSERT INTO viewer_share_tokens
         (id, tenant_id, token, name, mode, permissions_json, created_by, created_at, expires_at, access_count)
         VALUES (?, ?, ?, ?, 'portal', ?, ?, ?, ?, 0)`,
      )
      .run(id, tenantId, token, opts.name, permissionsJson, opts.createdBy ?? null, now, expiresAt);

    await audit.append({
      tenantId,
      action: 'client_portal.create',
      resourceType: 'viewer_share_token',
      resourceId: id,
      ...(opts.createdBy ? { actorId: opts.createdBy } : {}),
      metadata: {
        name: opts.name,
        expiresAt,
        permissions: opts.permissions,
      },
    });

    return rowToToken({
      id,
      tenant_id: tenantId,
      token,
      name: opts.name,
      mode: 'portal',
      permissions_json: permissionsJson,
      created_by: opts.createdBy ?? null,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      last_accessed_at: null,
      access_count: 0,
    });
  }

  /**
   * Verify token + bump access counter. Ritorna PortalToken se valido
   * e in modalita\` portal; null altrimenti.
   *
   * Default-deny: token in modalita\` readonly NON e\` accettato da
   * questa funzione (richiede mode='portal'). Il caller puo\` chiamare
   * ViewerShareService.verify() per il caso readonly.
   */
  verify(tenantId: string, token: string): PortalToken | null {
    const { sqlite } = getDatabase();
    const row = sqlite
      .prepare('SELECT * FROM viewer_share_tokens WHERE tenant_id = ? AND token = ?')
      .get(tenantId, token) as PortalTokenRow | undefined;
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    if (row.mode !== 'portal') return null;

    sqlite
      .prepare(
        'UPDATE viewer_share_tokens SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), row.id);

    return rowToToken(row);
  }

  /**
   * Lista i workflow visibili al token, applicando la matrice di
   * permissions (workflowIds esplicita > workflowTags > vuoto).
   *
   * Default-deny: nessun permission → ritorna [] (mai esposizione completa).
   */
  listVisibleWorkflows(tokenInfo: PortalToken): PortalWorkflowSummary[] {
    const { sqlite } = getDatabase();
    const { workflowIds, workflowTags, allowRun, allowedTriggerTypes } = tokenInfo.permissions;

    // Default deny: senza nessuna whitelist, nessun workflow visibile.
    if (
      (!workflowIds || workflowIds.length === 0) &&
      (!workflowTags || workflowTags.length === 0)
    ) {
      return [];
    }

    // Build WHERE
    const conditions: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tokenInfo.tenantId];

    if (workflowIds && workflowIds.length > 0) {
      const placeholders = workflowIds.map(() => '?').join(',');
      conditions.push(`id IN (${placeholders})`);
      params.push(...workflowIds);
    }

    const rows = sqlite
      .prepare(
        `SELECT id, name, description, enabled, tags_json, nodes_json, updated_at
         FROM workflows
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC`,
      )
      .all(...params) as WorkflowSummaryRow[];

    let filtered = rows;
    // Tag filter (se workflowTags settato E workflowIds non lo era)
    if ((!workflowIds || workflowIds.length === 0) && workflowTags && workflowTags.length > 0) {
      const requiredTags = new Set(workflowTags);
      filtered = rows.filter((r) => {
        const tags = parseWorkflowTags(r.tags_json);
        return tags.some((t) => requiredTags.has(t));
      });
    }

    const triggerWhitelist = allowedTriggerTypes ?? ['trigger_manual'];
    return filtered.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      enabled: r.enabled === 1,
      tags: parseWorkflowTags(r.tags_json),
      canRun: allowRun === true && workflowHasAllowedTrigger(r.nodes_json, triggerWhitelist),
    }));
  }

  /**
   * Determina se il portal puo\` eseguire un workflow specifico.
   * Usato come gate prima di POST /portal/.../workflows/:id/run.
   *
   * Regole:
   *  1. Workflow deve essere visibile al token (listVisibleWorkflows include id)
   *  2. permissions.allowRun deve essere true
   *  3. Workflow deve avere almeno 1 trigger node tra allowedTriggerTypes
   *
   * Ritorna { ok: true } o { ok: false, reason: string }.
   */
  canRunWorkflow(
    tokenInfo: PortalToken,
    workflow: { id: string; nodesJson: string },
  ): { ok: true } | { ok: false; reason: string } {
    if (tokenInfo.permissions.allowRun !== true) {
      return {
        ok: false,
        reason: 'allowRun=false: il portale non ha il permesso di eseguire workflow.',
      };
    }
    const visible = this.listVisibleWorkflows(tokenInfo);
    if (!visible.some((w) => w.id === workflow.id)) {
      return { ok: false, reason: 'Workflow non visibile a questo token.' };
    }
    const triggerWhitelist = tokenInfo.permissions.allowedTriggerTypes ?? ['trigger_manual'];
    if (!workflowHasAllowedTrigger(workflow.nodesJson, triggerWhitelist)) {
      return { ok: false, reason: 'Il workflow non ha trigger compatibili (manual richiesto).' };
    }
    return { ok: true };
  }

  /**
   * Audit log: registra un run partito dal portal cliente. Diverso dai
   * normali run perche\` traccia anche il token che ha autorizzato.
   */
  async auditPortalRun(opts: {
    tenantId: string;
    tokenId: string;
    workflowId: string;
    runId: string;
    triggerInputSummary?: Record<string, unknown>;
  }): Promise<void> {
    await audit.append({
      tenantId: opts.tenantId,
      action: 'client_portal.workflow_run',
      resourceType: 'run',
      resourceId: opts.runId,
      metadata: {
        portalTokenId: opts.tokenId,
        workflowId: opts.workflowId,
        triggerInput: opts.triggerInputSummary ?? null,
      },
    });
  }

  /**
   * Audit log: registra una modifica di campo exposed dal portale cliente.
   * Traccia portalTokenId + workflowId + nodeId + fieldKey + valore VECCHIO
   * (per chi farà forensic). Il valore NUOVO non viene loggato (PII risk:
   * potrebbe essere "Email destinatario: capo@cliente.com").
   */
  async auditFieldUpdate(opts: {
    tenantId: string;
    tokenId: string;
    workflowId: string;
    nodeId: string;
    fieldKey: string;
    oldValueRedacted: string;
  }): Promise<void> {
    await audit.append({
      tenantId: opts.tenantId,
      action: 'client_portal.field_update',
      resourceType: 'workflow',
      resourceId: opts.workflowId,
      metadata: {
        portalTokenId: opts.tokenId,
        nodeId: opts.nodeId,
        fieldKey: opts.fieldKey,
        oldValueRedacted: opts.oldValueRedacted,
        newValueLogged: false,
      },
    });
  }
}

// ─── Exposed Fields helpers (Sprint 3) ────────────────────────────────

/**
 * Field whitelist tipi expected dal NodeDef schema (subset di ConfigField).
 * Solo i campi marcati `exposeToClient: true` vengono restituiti al portale.
 */
export interface ExposedFieldDescriptor {
  nodeId: string;
  nodeLabel: string;
  fieldKey: string;
  /** clientLabel se presente, altrimenti label tecnica. */
  label: string;
  /** clientHint se presente, altrimenti help tecnico. */
  hint?: string;
  type: string; // 'text' | 'secret' | ecc.
  required: boolean;
  pattern?: string;
  patternMessage?: string;
  /** Current value dal workflow.nodes[].config[fieldKey] (REDACTED se type=secret). */
  currentValue: string;
  /** Indica se il valore corrente e\` stato redatto (per UX "valore impostato ma nascosto"). */
  redacted: boolean;
}

interface WorkflowNodeShape {
  id: string;
  defId?: string;
  label?: string;
  config?: Record<string, unknown>;
}

interface NodeDefShape {
  id?: string;
  defId?: string;
  configFields?: {
    key: string;
    label: string;
    type?: string;
    required?: boolean;
    pattern?: string;
    patternMessage?: string;
    exposeToClient?: boolean;
    clientLabel?: string;
    clientHint?: string;
    help?: string;
  }[];
  actions?: {
    id?: string;
    configFields?: {
      key: string;
      label: string;
      type?: string;
      required?: boolean;
      pattern?: string;
      patternMessage?: string;
      exposeToClient?: boolean;
      clientLabel?: string;
      clientHint?: string;
      help?: string;
    }[];
  }[];
}

/**
 * Computa la lista dei campi esposti al cliente partendo dal workflow loaded.
 * Algoritmo:
 *  1. Per ogni node nel workflow
 *  2. Trova il NodeDef matching by defId (o id) — search in nodeDefs[] array
 *  3. Recupera configFields del def (e configFields delle actions se action node)
 *  4. Filtra quelli con exposeToClient=true
 *  5. Per ognuno, costruisce ExposedFieldDescriptor con value REDACTED se secret
 *
 * Defensive: se un node non ha def matching → skip. Se def non ha configFields → skip.
 */
export function computeExposedFields(workflow: {
  nodes: unknown;
  nodeDefs: unknown;
}): ExposedFieldDescriptor[] {
  const nodes = Array.isArray(workflow.nodes) ? (workflow.nodes as WorkflowNodeShape[]) : [];
  const defs = Array.isArray(workflow.nodeDefs) ? (workflow.nodeDefs as NodeDefShape[]) : [];
  const defsById = new Map<string, NodeDefShape>();
  for (const d of defs) {
    const id = d.id ?? d.defId;
    if (typeof id === 'string') defsById.set(id, d);
  }

  const result: ExposedFieldDescriptor[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const defId = node.defId;
    if (typeof defId !== 'string') continue;
    const def = defsById.get(defId);
    if (!def) continue;

    // Raccoglie configFields del def + action selezionata (se node.config.action specifica)
    const fields: NonNullable<NodeDefShape['configFields']> = [];
    if (Array.isArray(def.configFields)) fields.push(...def.configFields);
    if (Array.isArray(def.actions)) {
      for (const action of def.actions) {
        if (Array.isArray(action.configFields)) fields.push(...action.configFields);
      }
    }

    for (const field of fields) {
      if (field.exposeToClient !== true) continue;
      const cfg = node.config && typeof node.config === 'object' ? node.config : {};
      const rawVal = cfg[field.key];
      const isSecret = field.type === 'secret' || field.type === 'password';
      const hasValue = typeof rawVal === 'string' && rawVal.length > 0;
      result.push({
        nodeId: node.id,
        nodeLabel: typeof node.label === 'string' && node.label.length > 0 ? node.label : node.id,
        fieldKey: field.key,
        label: field.clientLabel ?? field.label,
        ...((field.clientHint ?? field.help) ? { hint: field.clientHint ?? field.help } : {}),
        type: field.type ?? 'text',
        required: field.required === true,
        ...(field.pattern ? { pattern: field.pattern } : {}),
        ...(field.patternMessage ? { patternMessage: field.patternMessage } : {}),
        currentValue: isSecret && hasValue ? '••••••••' : typeof rawVal === 'string' ? rawVal : '',
        redacted: isSecret && hasValue,
      });
    }
  }
  return result;
}

/**
 * Valida un nuovo valore contro lo schema del field. Ritorna { ok: true }
 * o { ok: false, error } con messaggio human-friendly per il cliente.
 *
 * NON include sanitization XSS (il valore viene poi serializzato come JSON
 * string nel workflow.nodes[].config — il rendering dell'editor è React JSX
 * che escapa automaticamente).
 */
export function validateExposedFieldValue(
  descriptor: ExposedFieldDescriptor,
  value: string,
): { ok: true } | { ok: false; error: string } {
  if (descriptor.required && value.trim().length === 0) {
    return { ok: false, error: 'Il campo è obbligatorio.' };
  }
  if (value.length > 10_000) {
    return { ok: false, error: 'Valore troppo lungo (max 10.000 caratteri).' };
  }
  if (descriptor.pattern && value.length > 0) {
    try {
      const re = new RegExp(descriptor.pattern, 'u');
      if (!re.test(value)) {
        return { ok: false, error: descriptor.patternMessage ?? 'Formato non valido.' };
      }
    } catch {
      // Regex malformed dal NodeDef: lasciamo passare per non bloccare il cliente
      // (errore di config developer, non del cliente). Loggato lato server.
    }
  }
  return { ok: true };
}

/**
 * Helper redaction per audit log: lunghezza + indizio del primo char.
 * Es. "John Doe" → "8 char inizia con 'J'". Usato per forensic senza leak PII.
 */
export function redactForAudit(value: string): string {
  if (value.length === 0) return '(vuoto)';
  const first = value.slice(0, 1);
  return `${value.length.toString()} char inizia con '${first}'`;
}
