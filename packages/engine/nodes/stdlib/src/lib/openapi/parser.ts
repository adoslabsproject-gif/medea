/**
 * OpenAPI 3.0 parser + request builder — il cuore dell'OpenAPI Connector
 * (gap #17, leva "1 nodo copre migliaia di API"). Data una spec, estrae le
 * operations (path × method) e costruisce la richiesta HTTP per una operation
 * selezionata sostituendo path/query/header params. Puro e testabile.
 */

export type ParamLocation = 'path' | 'query' | 'header';

export interface OpenApiParameter {
  name: string;
  in: ParamLocation;
  required: boolean;
}

export interface OpenApiOperation {
  /** Identificatore stabile (operationId della spec, o `METHOD path` come fallback). */
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Path template, es. "/users/{id}". */
  path: string;
  summary?: string;
  parameters: OpenApiParameter[];
  /** True se l'operation accetta un request body (POST/PUT/PATCH con requestBody). */
  hasBody: boolean;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

interface RawParam {
  name?: unknown;
  in?: unknown;
  required?: unknown;
}

function parseParams(raw: unknown): OpenApiParameter[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenApiParameter[] = [];
  for (const p of raw as RawParam[]) {
    if (typeof p.name !== 'string') continue;
    const loc = p.in;
    if (loc !== 'path' && loc !== 'query' && loc !== 'header') continue;
    out.push({ name: p.name, in: loc, required: p.required === true });
  }
  return out;
}

/** Estrae tutte le operations da una spec OpenAPI 3.0 (oggetto già parsato). */
export function parseOpenApiOperations(spec: unknown): OpenApiOperation[] {
  if (spec === null || typeof spec !== 'object') return [];
  const paths = (spec as { paths?: unknown }).paths;
  if (paths === null || typeof paths !== 'object') return [];
  const ops: OpenApiOperation[] = [];
  for (const [path, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (pathItemRaw === null || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    // Parametri condivisi a livello di path (ereditati da tutte le operations).
    const sharedParams = parseParams(pathItem.parameters);
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (opRaw === null || typeof opRaw !== 'object') continue;
      const op = opRaw as Record<string, unknown>;
      const opParams = parseParams(op.parameters);
      // Dedup per (name,in): l'operation override sul path-level.
      const merged = new Map<string, OpenApiParameter>();
      for (const p of [...sharedParams, ...opParams]) merged.set(`${p.in}:${p.name}`, p);
      ops.push({
        operationId:
          typeof op.operationId === 'string' && op.operationId
            ? op.operationId
            : `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase() as OpenApiOperation['method'],
        path,
        ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
        parameters: [...merged.values()],
        hasBody: op.requestBody !== null && typeof op.requestBody === 'object',
      });
    }
  }
  return ops;
}

/** Base URL dalla spec (primo `servers[].url`), o null se assente. */
export function openApiBaseUrl(spec: unknown): string | null {
  if (spec === null || typeof spec !== 'object') return null;
  const servers = (spec as { servers?: unknown }).servers;
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const first = servers[0] as { url?: unknown };
  return typeof first.url === 'string' ? first.url : null;
}

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Query params da appendere (già URL-encoded a valle dal caller/fetch). */
  query: Record<string, string>;
}

/**
 * Costruisce la richiesta per una operation: sostituisce i path param `{name}`,
 * raccoglie query e header param dai valori forniti. I path param required
 * mancanti sono un errore esplicito (l'URL sarebbe malformato).
 */
export function buildOpenApiRequest(
  op: OpenApiOperation,
  baseUrl: string,
  values: Record<string, string>,
): BuiltRequest {
  let path = op.path;
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const p of op.parameters) {
    const v = values[p.name];
    if (p.in === 'path') {
      if (v === undefined || v === '') {
        if (p.required)
          throw new Error(`OpenAPI: path param "${p.name}" mancante per ${op.operationId}`);
        continue;
      }
      path = path.replace(`{${p.name}}`, encodeURIComponent(v));
    } else if (p.in === 'query') {
      if (v !== undefined && v !== '') query[p.name] = v;
    } else {
      if (v !== undefined && v !== '') headers[p.name] = v;
    }
  }
  const base = baseUrl.replace(/\/+$/u, '');
  return { url: `${base}${path}`, method: op.method, headers, query };
}
