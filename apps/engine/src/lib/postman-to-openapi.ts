/**
 * postman-to-openapi — converte una Postman Collection (v2.0/v2.1) in uno spec
 * OpenAPI 3.0, da dare in pasto a `generateNodeFromOpenApi`.
 *
 * Scelta di design (sicurezza): NON genero direttamente executor/definition.
 * Produco solo lo spec OpenAPI e riuso il generatore già revisionato → il nodo
 * finale eredita TUTTE le sue proprietà di sicurezza (metadati come dati via
 * JSON.stringify, key sanitizzate, encodeURIComponent sui path, executor
 * shimmato dal sandbox, firma sul bundle eseguito). Zero nuova superficie di
 * esecuzione.
 *
 * Mapping:
 *   - collection.info.name           → info.title
 *   - variabile {{baseUrl}}/host     → servers[0].url (best-effort + warning)
 *   - cartelle (item annidati)       → tags (risorse)
 *   - ogni request                   → operation (method + path); query/header
 *     → parameters; body raw JSON     → requestBody application/json
 *   - collection.auth                → securitySchemes (bearer/basic/apikey)
 *
 * PURO e deterministico. I {{placeholder}} Postman restano nei valori (l'utente
 * li sostituisce nei config del nodo); il path li mantiene come segmenti.
 */

export interface PostmanConvertResult {
  spec: Record<string, unknown>;
  warnings: string[];
}

export class PostmanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostmanParseError';
  }
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

interface PlannedOp {
  method: string;
  path: string;
  name: string;
  tag: string | undefined;
  query: { name: string; description?: string }[];
  headers: string[];
  hasJsonBody: boolean;
  host: string | undefined;
}

/** Converte i path-param Postman `:id` in `{id}` (il generatore interpola `{}`). */
function normalizePathParams(path: string): string {
  return path.replace(/:([a-zA-Z0-9_]+)/gu, '{$1}');
}

/** Estrae i segmenti path da un url Postman (string o object). */
function extractPath(url: unknown): { path: string; query: { name: string; description?: string }[]; host?: string } {
  // url può essere stringa "https://api.x.com/v1/charges?limit=2" o oggetto.
  if (typeof url === 'string') {
    return parseRawUrl(url);
  }
  const u = asRecord(url);
  if (!u) return { path: '/', query: [] };
  if (str(u.raw) && !Array.isArray(u.path)) {
    // raw presente ma path non strutturato → parse del raw.
    const parsed = parseRawUrl(u.raw as string);
    if (parsed.path !== '/') return parsed;
  }
  const segs = arr(u.path)
    .map((s) => (typeof s === 'string' ? s : str(asRecord(s)?.value) ?? ''))
    .filter((s) => s.length > 0);
  const path = '/' + segs.join('/');
  const query = arr(u.query)
    .map((q) => asRecord(q))
    .filter((q): q is Record<string, unknown> => !!q && !!str(q.key))
    .map((q) => {
      const desc = str(q.description);
      return desc ? { name: str(q.key)!, description: desc } : { name: str(q.key)! };
    });
  const hostArr = arr(u.host).map((h) => (typeof h === 'string' ? h : '')).filter(Boolean);
  const host = hostArr.length > 0 ? hostArr.join('.') : str(u.host);
  const result: { path: string; query: { name: string; description?: string }[]; host?: string } = {
    path: path === '/' ? '/' : path,
    query,
  };
  if (host) result.host = host;
  return result;
}

function parseRawUrl(raw: string): { path: string; query: { name: string; description?: string }[]; host?: string } {
  // Non usa new URL() perché i raw Postman contengono {{var}} non validi come URL.
  // Strip dello schema+host se presente, isola path e query string.
  const noProto = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, '');
  const slash = noProto.indexOf('/');
  const host = slash > 0 ? noProto.slice(0, slash) : (raw.includes('://') ? noProto : undefined);
  const rest = slash >= 0 ? noProto.slice(slash) : (host ? '/' : noProto);
  const [pathPart, queryPart] = rest.split('?', 2);
  const query = (queryPart ?? '')
    .split('&')
    .map((kv) => kv.split('=', 1)[0])
    .filter((k): k is string => !!k && k.length > 0)
    .map((k) => ({ name: k }));
  const result: { path: string; query: { name: string; description?: string }[]; host?: string } = {
    path: pathPart?.startsWith('/') ? pathPart : `/${pathPart ?? ''}`,
    query,
  };
  if (host && !host.includes('{{')) result.host = host;
  return result;
}

/** Visita ricorsivamente item/folder; accumula le operazioni con il tag (folder). */
function walkItems(items: unknown[], parentTag: string | undefined, out: PlannedOp[], warnings: string[]): void {
  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const name = str(item.name) ?? 'request';

    if (Array.isArray(item.item)) {
      // È una cartella: il suo nome diventa il tag dei figli (folder annidate →
      // tag della più interna, per restare a un livello come fa OpenAPI tags).
      walkItems(item.item, name, out, warnings);
      continue;
    }

    const request = asRecord(item.request);
    if (!request) continue;
    const method = (str(request.method) ?? 'GET').toLowerCase();
    if (!HTTP_METHODS.has(method)) {
      warnings.push(`Request "${name}": metodo "${method}" non supportato, saltata.`);
      continue;
    }
    const { path, query, host } = extractPath(request.url);
    const headers = arr(request.header)
      .map((h) => asRecord(h))
      .filter((h): h is Record<string, unknown> => !!h && !!str(h.key) && h.disabled !== true)
      .map((h) => str(h.key)!)
      // Header gestiti dall'auth/standard → non li esponiamo come parametri.
      .filter((k) => !['authorization', 'content-type', 'accept'].includes(k.toLowerCase()));

    // Auth per-request: solo la collection.auth globale diventa securityScheme.
    // Se la singola request ha la PROPRIA auth, l'header Authorization è escluso
    // dai parametri e non c'è scheme → la request perderebbe l'auth in silenzio.
    // Lo segnaliamo così l'utente la riconfigura nel nodo.
    if (asRecord(request.auth)) {
      warnings.push(
        `Request "${name}": auth definita a livello di request non mappata ` +
          `(solo l'auth globale della collection diventa security scheme) — configura l'auth nel nodo.`,
      );
    }

    const body = asRecord(request.body);
    // Body raw → trattato come JSON (modalità più comune). I mode non-raw
    // (formdata/urlencoded/file) non sono mappati: warning.
    const mode = str(body?.mode);
    if (body && mode && mode !== 'raw') {
      warnings.push(`Request "${name}": body mode "${mode}" non mappato (solo raw/JSON) — riconfigura a mano.`);
    }

    out.push({
      method,
      path: normalizePathParams(path || '/'),
      name,
      tag: parentTag,
      query,
      headers,
      hasJsonBody: !!body && mode === 'raw',
      host,
    });
  }
}

/** Estrae il security scheme dalla collection.auth Postman. */
function extractAuth(collection: Record<string, unknown>): Record<string, unknown> | undefined {
  const auth = asRecord(collection.auth);
  const type = str(auth?.type);
  if (!auth || !type) return undefined;
  if (type === 'bearer') return { bearerAuth: { type: 'http', scheme: 'bearer' } };
  if (type === 'basic') return { basicAuth: { type: 'http', scheme: 'basic' } };
  if (type === 'apikey') {
    // Postman apikey: array di {key,value} con key='key'|'in'|'value'.
    const fields = arr(auth.apikey).map((f) => asRecord(f)).filter((f): f is Record<string, unknown> => !!f);
    const nameField = fields.find((f) => str(f.key) === 'key');
    const inField = fields.find((f) => str(f.key) === 'in');
    const name = str(nameField?.value) ?? 'X-API-Key';
    const loc = str(inField?.value) === 'query' ? 'query' : 'header';
    return { apiKeyAuth: { type: 'apiKey', in: loc, name } };
  }
  return undefined;
}

/**
 * Converte una Postman Collection in uno spec OpenAPI 3.0.
 * Lancia `PostmanParseError` se non è una collection riconoscibile.
 */
export function postmanToOpenApi(collectionRaw: unknown): PostmanConvertResult {
  const collection = asRecord(collectionRaw);
  if (!collection) throw new PostmanParseError('La collection Postman deve essere un oggetto JSON.');
  const info = asRecord(collection.info);
  if (!info || !str(info.name)) {
    throw new PostmanParseError('Collection Postman non valida: manca info.name.');
  }
  if (!Array.isArray(collection.item)) {
    throw new PostmanParseError('Collection Postman non valida: manca l\'array "item".');
  }

  const warnings: string[] = [];
  const ops: PlannedOp[] = [];
  walkItems(collection.item, undefined, ops, warnings);
  if (ops.length === 0) {
    throw new PostmanParseError('La collection non contiene request HTTP importabili.');
  }

  // baseUrl: host più frequente tra le request (best-effort, ordine stabile).
  const hostCounts = new Map<string, number>();
  for (const op of ops) {
    if (op.host) hostCounts.set(op.host, (hostCounts.get(op.host) ?? 0) + 1);
  }
  let baseUrl: string | undefined;
  let best = 0;
  for (const [host, n] of [...hostCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > best) { best = n; baseUrl = `https://${host}`; }
  }
  if (!baseUrl) warnings.push('Nessun host costante nelle request (probabili variabili {{baseUrl}}): compila "baseUrl" nel nodo.');

  // paths OpenAPI: raggruppa per path, poi per metodo. operationId dal nome request.
  const paths: Record<string, Record<string, unknown>> = {};
  const usedOpIds = new Set<string>();
  for (const op of ops) {
    const pathItem = paths[op.path] ?? (paths[op.path] = {});
    let opId = op.name;
    let n = 2;
    while (usedOpIds.has(opId)) { opId = `${op.name}_${n}`; n += 1; }
    usedOpIds.add(opId);

    const parameters = [
      ...op.query.map((q) => ({ name: q.name, in: 'query', required: false, schema: { type: 'string' }, ...(q.description ? { description: q.description } : {}) })),
      ...op.headers.map((h) => ({ name: h, in: 'header', required: false, schema: { type: 'string' } })),
      ...extractPathParams(op.path),
    ];
    const operation: Record<string, unknown> = {
      operationId: opId,
      summary: op.name,
      ...(op.tag ? { tags: [op.tag] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.hasJsonBody ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
    };
    // OpenAPI: (path, method) è unico. Due request Postman con lo stesso metodo
    // e path (es. due GET /charges in folder diverse) collidono: la seconda
    // sovrascriverebbe la prima. Lo segnaliamo invece di perdere l'operazione
    // in silenzio (l'utente può rinominare o accorpare a mano).
    if (pathItem[op.method]) {
      warnings.push(
        `Collisione: ${op.method.toUpperCase()} ${op.path} compare più volte (es. "${op.name}") — ` +
          `in OpenAPI path+metodo è unico, tengo solo la prima. Differenzia il path o accorpa.`,
      );
      continue;
    }
    pathItem[op.method] = operation;
  }

  const securitySchemes = extractAuth(collection);
  const spec: Record<string, unknown> = {
    openapi: '3.0.3',
    info: { title: str(info.name)!, version: '1.0.0', ...(str(info.description) ? { description: str(info.description) } : {}) },
    ...(baseUrl ? { servers: [{ url: baseUrl }] } : {}),
    ...(securitySchemes ? { components: { securitySchemes } } : {}),
    paths,
  };
  return { spec, warnings };
}

/** Estrae i path param `{id}` dal path (già normalizzato) → parameters in=path. */
function extractPathParams(path: string): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const m of path.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    params.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  return params;
}
