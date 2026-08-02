/**
 * openapi-to-node — generatore: spec OpenAPI 3.x → Custom Node FlowForge.
 *
 * È la leva che chiude il gap di integrazioni con n8n SENZA scrivere nodi a
 * mano: qualunque API con uno spec OpenAPI diventa un nodo FlowForge tipizzato.
 * Mapping (allineato al pattern Resource/Operation di core/schema/nodes.ts):
 *   - spec.info.title         → display name + slug del nodo
 *   - servers[0].url          → baseUrl di default (override-abile)
 *   - tags                    → NodeResource (risorse di primo livello)
 *   - ogni operation          → NodeAction (operazione), resource = primo tag
 *   - parameters/requestBody  → configFields dell'azione (path/query/header/body)
 *   - securitySchemes         → configFields CONDIVISI (apiKey/bearer/basic)
 *
 * Produce i 3 sorgenti che `createCustomNode` si aspetta:
 *   - sourceDefinition: `export const definition = {...}` (NodeDef valido)
 *   - sourceExecutor:   `export const executor = async (config, input) => {...}`
 *     — connettore HTTP generico che dispatcha su `config.__action`. NIENTE
 *       require/eval/Function/process.env/child_process (passerebbe il
 *       securityScan del compile.service); usa solo `fetch` (globale nel sandbox).
 *   - sourceSchema:     `export const schema = z.object({...})`
 *
 * PURO e deterministico: nessun I/O, nessuna dipendenza dal runtime. Lo stesso
 * spec produce sempre lo stesso output (operazioni ordinate) → testabile e
 * diff-abile. La persistenza/compilazione è responsabilità del chiamante.
 */

/** Metodi HTTP che diventano operazioni (lowercase come nelle chiavi OpenAPI). */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Cap difensivo: spec enormi (centinaia di endpoint) → un nodo gestibile. */
const DEFAULT_MAX_OPERATIONS = 200;

export interface OpenApiImportOptions {
  /** Slug kebab-case; default derivato da info.title. */
  slug?: string;
  /** Override del baseUrl (utile se lo spec usa server relativi o placeholder). */
  baseUrlOverride?: string;
  /** Cap operazioni (default 200) — oltre, le restanti finiscono nei warning. */
  maxOperations?: number;
}

export interface GeneratedCustomNode {
  slug: string;
  displayName: string;
  description: string;
  category: 'HTTP / Webhooks';
  sourceDefinition: string;
  sourceExecutor: string;
  sourceSchema: string;
  stats: { operations: number; resources: number; skipped: number };
  warnings: string[];
}

export class OpenApiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiParseError';
  }
}

// ─── helper di normalizzazione ──────────────────────────────────────────────

/** kebab-case slug: lowercase, non-alfanumerici → `-`, niente doppi/bordi. */
export function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return s || 'api';
}

/**
 * Identificatore operazione (valore del select `operation`): alfanumerico +
 * `_`/`-` (regex Action id del community-node-sdk: /^[a-z0-9_-]+$/i).
 */
function sanitizeId(input: string): string {
  const s = input
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'op';
}

/**
 * Chiave di un config field: SOLO `[a-zA-Z0-9_]` (regex ConfigField del
 * community-node-sdk). Niente trattini/punti, pena rifiuto dello schema.
 */
function sanitizeKey(input: string): string {
  const s = input
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'p';
}

/** Garantisce unicità in un set, suffissando `_2`, `_3`… */
function uniqueIn(set: Set<string>, candidate: string): string {
  let id = candidate;
  let n = 2;
  while (set.has(id)) {
    id = `${candidate}_${n}`;
    n += 1;
  }
  set.add(id);
  return id;
}

// ─── tipi interni (shape OpenAPI rilevante, validato difensivamente) ─────────

interface RawParam {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  description?: unknown;
  schema?: { type?: unknown } | undefined;
}

/** Metadato di un parametro, embeddato nell'executor per costruire la request. */
interface ParamMeta {
  name: string; // nome OpenAPI (per path interpolation / query key)
  key: string; // config field key (unico nell'azione)
  loc: 'path' | 'query' | 'header';
}

interface OperationPlan {
  actionId: string;
  method: HttpMethod;
  path: string;
  label: string;
  description: string;
  resource: string | undefined;
  params: ParamMeta[];
  bodyKey: string | undefined; // config key del body JSON, se l'operation ha requestBody json
}

interface AuthPlan {
  /** tipo normalizzato; 'none' = nessuno schema riconosciuto. */
  kind: 'none' | 'apiKeyHeader' | 'apiKeyQuery' | 'bearer' | 'basic';
  /** per apiKey: nome dell'header/query param. */
  paramName?: string;
  /** config key che porta il secret (apiKey/bearer/basic). */
  secretKey?: string;
  /** per basic: config key dell'username (la password sta in secretKey). */
  userKey?: string;
}

// ─── parsing ────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Estrae baseUrl da servers[0].url (3.x). */
function extractBaseUrl(spec: Record<string, unknown>): string | undefined {
  const servers = spec.servers;
  if (Array.isArray(servers) && servers.length > 0) {
    const first = asRecord(servers[0]);
    return str(first?.url);
  }
  return undefined;
}

/** Estrae il primo security scheme utilizzabile → AuthPlan. */
function extractAuth(spec: Record<string, unknown>, warnings: string[]): AuthPlan {
  const components = asRecord(spec.components);
  const schemes = asRecord(components?.securitySchemes);
  if (!schemes) return { kind: 'none' };

  const entries = Object.entries(schemes);
  if (entries.length === 0) return { kind: 'none' };
  if (entries.length > 1) {
    warnings.push(
      `Lo spec dichiara ${entries.length} security scheme; il nodo configura il primo (` +
        `${entries[0]![0]}). Gli altri vanno gestiti a mano nei campi auth.`,
    );
  }

  const scheme = asRecord(entries[0]![1]);
  if (!scheme) return { kind: 'none' };
  const type = str(scheme.type);

  if (type === 'apiKey') {
    const inLoc = str(scheme.in);
    const name = str(scheme.name) ?? 'X-API-Key';
    if (inLoc === 'query')
      return { kind: 'apiKeyQuery', paramName: name, secretKey: 'auth_api_key' };
    // header (default) — 'cookie' non supportato lato sandbox → trattato come header con warning
    if (inLoc === 'cookie') {
      warnings.push(
        'Security scheme apiKey in cookie non supportato dal sandbox; esposto come header.',
      );
    }
    return { kind: 'apiKeyHeader', paramName: name, secretKey: 'auth_api_key' };
  }
  if (type === 'http') {
    const scheme2 = (str(scheme.scheme) ?? '').toLowerCase();
    if (scheme2 === 'bearer') return { kind: 'bearer', secretKey: 'auth_bearer_token' };
    if (scheme2 === 'basic')
      return { kind: 'basic', secretKey: 'auth_basic_password', userKey: 'auth_basic_user' };
    warnings.push(
      `Security scheme http "${scheme2}" non riconosciuto; auth da configurare a mano.`,
    );
    return { kind: 'none' };
  }
  if (type === 'oauth2' || type === 'openIdConnect') {
    warnings.push(
      `Security scheme "${type}" non auto-configurabile (richiede flow OAuth); usa il token come Bearer ` +
        `nel campo auth o l'OAuth multi-tenant del portal.`,
    );
    return { kind: 'bearer', secretKey: 'auth_bearer_token' };
  }
  return { kind: 'none' };
}

function defaultLabel(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Pianifica tutte le operazioni dello spec (ordine deterministico). */
function planOperations(
  spec: Record<string, unknown>,
  maxOps: number,
  warnings: string[],
): { operations: OperationPlan[]; resources: Set<string>; skipped: number } {
  const paths = asRecord(spec.paths) ?? {};
  const operations: OperationPlan[] = [];
  const resources = new Set<string>();
  const usedActionIds = new Set<string>();
  // Config flat: TUTTE le key (params di ogni op + body) condividono un unico
  // namespace → unicità globale.
  const usedConfigKeys = new Set<string>();
  let skipped = 0;

  // Ordine stabile: path alfabetico, poi metodo in ordine HTTP_METHODS.
  for (const path of Object.keys(paths).sort()) {
    const pathItem = asRecord(paths[path]);
    if (!pathItem) continue;
    // parametri condivisi a livello di path (OpenAPI 3.x).
    const pathLevelParams = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as RawParam[])
      : [];

    for (const method of HTTP_METHODS) {
      const op = asRecord(pathItem[method]);
      if (!op) continue;

      if (operations.length >= maxOps) {
        skipped += 1;
        continue;
      }

      const operationId = str(op.operationId);
      const baseId = sanitizeId(operationId ?? `${method}_${path}`);
      const actionId = uniqueIn(usedActionIds, baseId);

      const tags = Array.isArray(op.tags) ? (op.tags as unknown[]) : [];
      const resource = str(tags[0]) ? sanitizeId(str(tags[0])!) : undefined;
      if (resource) resources.add(resource);

      const label = str(op.summary) ?? defaultLabel(method, path);
      const description = str(op.description) ?? str(op.summary) ?? defaultLabel(method, path);

      // Parametri: path-level + operation-level. Dedup per (name+in).
      // Config flat (shape custom-node) → namespace per-operazione per evitare
      // collisioni tra op diverse: key = `<actionId>_<param>` (sanitizzata).
      const rawParams = [
        ...pathLevelParams,
        ...(Array.isArray(op.parameters) ? (op.parameters as RawParam[]) : []),
      ];
      const params: ParamMeta[] = [];
      const keyPrefix = sanitizeKey(actionId);
      const seen = new Set<string>();
      for (const rp of rawParams) {
        const name = str(rp?.name);
        const loc = str(rp?.in);
        if (!name || (loc !== 'path' && loc !== 'query' && loc !== 'header')) continue;
        const dedupKey = `${loc}:${name}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const key = uniqueIn(usedConfigKeys, sanitizeKey(`${keyPrefix}_${name}`));
        params.push({ name, key, loc });
      }

      // requestBody JSON → un singolo config field body (JSON), namespaced.
      let bodyKey: string | undefined;
      const reqBody = asRecord(op.requestBody);
      if (reqBody) {
        const content = asRecord(reqBody.content);
        const hasJson = content && Object.keys(content).some((ct) => ct.includes('json'));
        if (hasJson) {
          bodyKey = uniqueIn(usedConfigKeys, sanitizeKey(`${keyPrefix}_body`));
        } else if (content && Object.keys(content).length > 0) {
          warnings.push(
            `${actionId}: requestBody con content-type ${Object.keys(content).join('/')} ` +
              `(non-JSON) — invialo come body raw configurando l'header Content-Type a mano.`,
          );
          bodyKey = uniqueIn(usedConfigKeys, sanitizeKey(`${keyPrefix}_body`));
        }
      }

      operations.push({ actionId, method, path, label, description, resource, params, bodyKey });
    }
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} operazioni oltre il cap di ${maxOps} non incluse — rigenera con maxOperations più alto se servono.`,
    );
  }
  return { operations, resources, skipped };
}

// ─── costruzione configFields ────────────────────────────────────────────────

interface ShowIf {
  field: string;
  equals?: string;
}
interface ConfigFieldLike {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  help?: string;
  defaultValue?: string;
  options?: string[];
  showIf?: ShowIf;
}

/** Campi condivisi: selettore operazione + baseUrl + auth. */
function sharedConfigFields(
  operations: OperationPlan[],
  auth: AuthPlan,
  baseUrl: string | undefined,
  baseUrlOverride: string | undefined,
): ConfigFieldLike[] {
  const fields: ConfigFieldLike[] = [];
  const firstOp = operations[0]!;
  fields.push({
    key: 'operation',
    label: 'Operazione',
    type: 'select',
    required: true,
    options: operations.map((o) => o.actionId),
    defaultValue: firstOp.actionId,
    help: "Quale endpoint dell'API chiamare.",
  });
  fields.push({
    key: 'baseUrl',
    label: 'Base URL',
    type: 'text',
    required: true,
    help: "URL base dell'API (senza il path dell'operazione).",
    ...((baseUrlOverride ?? baseUrl) ? { defaultValue: baseUrlOverride ?? baseUrl! } : {}),
  });
  switch (auth.kind) {
    case 'apiKeyHeader':
      fields.push({
        key: auth.secretKey!,
        label: `API key (header ${auth.paramName})`,
        type: 'secret',
        required: true,
      });
      break;
    case 'apiKeyQuery':
      fields.push({
        key: auth.secretKey!,
        label: `API key (query ${auth.paramName})`,
        type: 'secret',
        required: true,
      });
      break;
    case 'bearer':
      fields.push({ key: auth.secretKey!, label: 'Bearer token', type: 'secret', required: true });
      break;
    case 'basic':
      fields.push({
        key: auth.userKey!,
        label: 'Username (Basic auth)',
        type: 'text',
        required: true,
      });
      fields.push({
        key: auth.secretKey!,
        label: 'Password (Basic auth)',
        type: 'secret',
        required: true,
      });
      break;
    case 'none':
      break;
  }
  return fields;
}

/** Campi per-operazione, visibili solo quando `operation` == actionId (showIf). */
function operationConfigFields(operations: OperationPlan[]): ConfigFieldLike[] {
  const fields: ConfigFieldLike[] = [];
  for (const op of operations) {
    for (const p of op.params) {
      fields.push({
        key: p.key,
        label: `${p.name} (${p.loc})`,
        type: 'text',
        help: `[${op.actionId}] parametro ${p.loc} "${p.name}".`,
        showIf: { field: 'operation', equals: op.actionId },
      });
    }
    if (op.bodyKey) {
      fields.push({
        key: op.bodyKey,
        label: 'Request body (JSON)',
        type: 'json',
        help: `[${op.actionId}] corpo della richiesta in JSON.`,
        showIf: { field: 'operation', equals: op.actionId },
      });
    }
  }
  return fields;
}

// ─── generazione sorgenti ─────────────────────────────────────────────────────

/** Metadato runtime embeddato nell'executor (1 entry per azione). */
interface OperationRuntimeMeta {
  method: string;
  path: string;
  params: ParamMeta[];
  bodyKey: string | undefined;
}

function buildExecutorSource(operations: OperationPlan[], auth: AuthPlan): string {
  const opMeta: Record<string, OperationRuntimeMeta> = {};
  for (const op of operations) {
    opMeta[op.actionId] = {
      method: op.method.toUpperCase(),
      path: op.path,
      params: op.params,
      bodyKey: op.bodyKey,
    };
  }
  // JSON.stringify dei metadati: dati, non codice → nessun rischio injection di
  // pattern proibiti (il securityScan ispeziona comunque il sorgente finale).
  const opsJson = JSON.stringify(opMeta);
  const authJson = JSON.stringify(auth);

  // L'executor è volutamente in JS pulito: niente import (zod non serve qui),
  // niente require/eval/Function/process. Usa `fetch` globale (sandbox).
  return `// Auto-generato da openapi-to-node — connettore HTTP per-operazione.
const OPERATIONS = ${opsJson};
const AUTH = ${authJson};

function applyAuth(headers, urlObj, config) {
  if (AUTH.kind === 'apiKeyHeader' && config[AUTH.secretKey]) {
    headers[AUTH.paramName] = String(config[AUTH.secretKey]);
  } else if (AUTH.kind === 'apiKeyQuery' && config[AUTH.secretKey]) {
    urlObj.searchParams.set(AUTH.paramName, String(config[AUTH.secretKey]));
  } else if (AUTH.kind === 'bearer' && config[AUTH.secretKey]) {
    headers['Authorization'] = 'Bearer ' + String(config[AUTH.secretKey]);
  } else if (AUTH.kind === 'basic' && config[AUTH.secretKey]) {
    const user = config[AUTH.userKey] ? String(config[AUTH.userKey]) : '';
    headers['Authorization'] = 'Basic ' + btoa(user + ':' + String(config[AUTH.secretKey]));
  }
}

export const executor = async (config, _input, _context) => {
  const cfg = config || {};
  const actionId = cfg.operation;
  const op = OPERATIONS[actionId];
  if (!op) {
    throw new Error('Operazione "' + String(actionId) + '" non riconosciuta in questo nodo.');
  }
  const base = String(cfg.baseUrl || '').replace(/\\/+$/, '');
  if (!base) throw new Error('Base URL mancante: configura il campo "baseUrl".');

  // Interpola i path param + raccogli query/header.
  let path = op.path;
  const headers = { 'Accept': 'application/json' };
  const queryPairs = [];
  for (const p of op.params) {
    const v = cfg[p.key];
    if (v === undefined || v === null || v === '') continue;
    if (p.loc === 'path') {
      path = path.split('{' + p.name + '}').join(encodeURIComponent(String(v)));
    } else if (p.loc === 'query') {
      queryPairs.push([p.name, String(v)]);
    } else if (p.loc === 'header') {
      headers[p.name] = String(v);
    }
  }

  const urlObj = new URL(base + path);
  for (const [k, v] of queryPairs) urlObj.searchParams.set(k, v);
  applyAuth(headers, urlObj, cfg);

  const init = { method: op.method, headers };
  if (op.bodyKey && cfg[op.bodyKey] !== undefined && cfg[op.bodyKey] !== '') {
    const raw = cfg[op.bodyKey];
    if (typeof raw === 'string') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = raw;
    } else {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(raw);
    }
  }

  const res = await fetch(urlObj.toString(), init);
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = text; }

  // Ritorno RAW (convenzione custom-node): l'host wrappa in { output }.
  return {
    status: res.status,
    ok: res.ok,
    body: parsed,
  };
};
`;
}

function buildDefinitionSource(
  defId: string,
  displayName: string,
  description: string,
  config: ConfigFieldLike[],
): string {
  // Shape custom-node (community-node-sdk NodeDefinition): defId/displayName/
  // kind/category/inputs/outputs/description/config[] flat.
  const definition = {
    defId,
    displayName,
    kind: 'action',
    category: 'integration',
    description,
    inputs: ['default'],
    outputs: ['default', 'error'],
    config,
  };

  return `export const definition = ${JSON.stringify(definition, null, 2)};\n`;
}

function buildSchemaSource(sharedFields: ConfigFieldLike[]): string {
  // Schema minimale: i campi condivisi obbligatori (operation + baseUrl + auth).
  // I campi per-operation hanno showIf e sono opzionali → passthrough.
  const lines = sharedFields
    .filter((f) => f.required)
    .map((f) => `    ${JSON.stringify(f.key)}: z.string().min(1),`);
  return `import { z } from 'zod';\nexport const schema = {\n  config: z.object({\n${lines.join('\n')}\n  }).passthrough(),\n};\n`;
}

// ─── entry point ──────────────────────────────────────────────────────────────

/**
 * Genera un Custom Node FlowForge da uno spec OpenAPI 3.x (oggetto JSON).
 * Lancia `OpenApiParseError` se lo spec non è 3.x o è privo di paths.
 */
export function generateNodeFromOpenApi(
  specRaw: unknown,
  opts: OpenApiImportOptions = {},
): GeneratedCustomNode {
  const spec = asRecord(specRaw);
  if (!spec) throw new OpenApiParseError('Lo spec OpenAPI deve essere un oggetto JSON.');

  const openapiVersion = str(spec.openapi);
  if (!openapiVersion) {
    if (str(spec.swagger)) {
      throw new OpenApiParseError(
        'Swagger 2.0 non supportato: converti lo spec a OpenAPI 3.x (es. con swagger2openapi).',
      );
    }
    throw new OpenApiParseError('Campo "openapi" mancante: atteso uno spec OpenAPI 3.x.');
  }
  if (!openapiVersion.startsWith('3.')) {
    throw new OpenApiParseError(`Versione OpenAPI "${openapiVersion}" non supportata: serve 3.x.`);
  }

  const info = asRecord(spec.info);
  const title = str(info?.title) ?? 'API';
  const apiVersion = str(info?.version);
  const slug = slugify(opts.slug ?? title);
  const displayName = title;
  const description =
    str(info?.description) ??
    `Connettore generato da OpenAPI per ${title}${apiVersion ? ` v${apiVersion}` : ''}.`;

  const warnings: string[] = [];
  const baseUrl = extractBaseUrl(spec);
  if (!baseUrl && !opts.baseUrlOverride) {
    warnings.push('Nessun server nello spec: il campo "baseUrl" andrà compilato a mano.');
  }
  const auth = extractAuth(spec, warnings);
  const maxOps = opts.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  const { operations, resources, skipped } = planOperations(spec, maxOps, warnings);

  if (operations.length === 0) {
    throw new OpenApiParseError('Lo spec non contiene operazioni (paths × metodi) importabili.');
  }

  const shared = sharedConfigFields(operations, auth, baseUrl, opts.baseUrlOverride);
  const perOp = operationConfigFields(operations);
  const config = [...shared, ...perOp];
  const defId = `custom_${slug}`;
  const desc = description.slice(0, 500);

  return {
    slug,
    displayName,
    description: desc,
    category: 'HTTP / Webhooks',
    sourceDefinition: buildDefinitionSource(defId, displayName, desc, config),
    sourceExecutor: buildExecutorSource(operations, auth),
    sourceSchema: buildSchemaSource(shared),
    stats: { operations: operations.length, resources: resources.size, skipped },
    warnings,
  };
}
