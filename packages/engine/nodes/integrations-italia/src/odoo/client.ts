/**
 * Odoo JSON-RPC client — minimal, dependency-free.
 *
 * Odoo espone DUE endpoint:
 *   • /jsonrpc      → JSON-RPC 2.0 (moderno, raccomandato Odoo 12+)
 *   • /xmlrpc/2/*   → XML-RPC legacy (Odoo 6.0+, parsing più verboso)
 *
 * Usiamo JSON-RPC: parsing nativo `JSON.parse`, no `xml2js`, payload più
 * compatto. Authenticate ritorna `uid` (integer), riusato in ogni execute_kw.
 *
 * Protocollo Odoo JSON-RPC (v2):
 *   POST /jsonrpc
 *   {
 *     "jsonrpc": "2.0",
 *     "method": "call",
 *     "params": {
 *       "service": "common" | "object" | "db",
 *       "method": "authenticate" | "execute_kw" | "version",
 *       "args": [...positional...]
 *     },
 *     "id": <correlation>
 *   }
 *
 * Response:
 *   { "jsonrpc":"2.0", "id":..., "result": <any> }
 *   { "jsonrpc":"2.0", "id":..., "error": { "code":..., "message":..., "data":{...} } }
 *
 * Errori Odoo: `error.data.name` contiene il fully-qualified class (es.
 * 'odoo.exceptions.AccessError'). Lo includiamo nel throw per debug.
 */

// SECURITY FIX 2026-05-31 (audit Phase 2 HIGH #2): safeFetchWithRedirects
// blocca SSRF via baseUrl puntato a 169.254.169.254 (IMDS AWS/GCP) o RFC1918.
import { safeFetchWithRedirects, readJsonCapped } from '@flowforge/safe-fetch';
import { executeWithHostBreaker } from '@flowforge/nodes-stdlib';

export interface OdooConnection {
  /** Base URL, es. https://erp.mio-cliente.com (no trailing slash). */
  url: string;
  /** Nome database Odoo, es. 'production'. */
  db: string;
  /** Username (login), es. 'admin@cliente.com'. */
  username: string;
  /** API key (Odoo 14+) o password legacy. */
  apiKey: string;
}

export class OdooError extends Error {
  constructor(
    message: string,
    public readonly odooClass?: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: { name?: string; debug?: string; message?: string };
  };
}

let correlationId = 0;
const nextId = (): number => ++correlationId;

async function jsonRpcCall<T>(
  url: string,
  service: 'common' | 'object' | 'db',
  method: string,
  args: unknown[],
  timeoutMs = 30_000,
): Promise<T> {
  const id = nextId();
  const endpoint = `${url.replace(/\/+$/, '')}/jsonrpc`;
  // Gateway: per-host circuit breaker (come fic/register-it/woo/wp) + safeFetch
  // (SSRF-guard sull'url USER-PROVIDED + timeout ONORATO via `timeoutMs`). NB: la
  // SafeFetchOptions ha la sua AbortSignal.timeout interna — un AbortController
  // esterno NON passato a fetch sarebbe stato dead code (e il param timeoutMs
  // ignorato): qui lo passiamo davvero.
  const res = await executeWithHostBreaker(endpoint, () =>
    safeFetchWithRedirects(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id }),
      timeoutMs,
    }),
  );

  if (!res.ok) {
    throw new OdooError(`HTTP ${res.status.toString()} da Odoo ${url}`, undefined, res.status);
  }
  const body = await readJsonCapped<JsonRpcResponse<T>>(res);
  if (body.error) {
    const klass = body.error.data?.name ?? 'unknown';
    const detail = body.error.data?.message ?? body.error.message;
    throw new OdooError(`[${klass}] ${detail}`, klass);
  }
  if (body.result === undefined) {
    throw new OdooError('Odoo JSON-RPC: result mancante', undefined);
  }
  return body.result;
}

/**
 * Autentica e ritorna uid. Cached per connection (memoize). API key Odoo 14+
 * è preferibile alla password — generabile da Preferences → Account Security
 * con scope ridotto.
 */
export async function odooAuthenticate(conn: OdooConnection): Promise<number> {
  const uid = await jsonRpcCall<number | false>(conn.url, 'common', 'authenticate', [
    conn.db,
    conn.username,
    conn.apiKey,
    {},
  ]);
  if (!uid || typeof uid !== 'number') {
    throw new OdooError(
      `Authenticate Odoo fallita: db="${conn.db}" username="${conn.username}". Verifica credentials/API key in Preferences → Account Security.`,
      'AccessDenied',
    );
  }
  return uid;
}

/**
 * Versione Odoo + info server. Utile per /health pre-check.
 */
export async function odooServerVersion(url: string): Promise<{ server_version: string; server_version_info: unknown[] }> {
  return jsonRpcCall(url, 'common', 'version', []);
}

/**
 * execute_kw — entry point universale per CRUD + metodi custom.
 *
 * Esempi:
 *   • search_read:   executeKw(conn, uid, 'res.partner', 'search_read',
 *                              [[['is_company','=',true]]], { fields:['name','vat'], limit:50 })
 *   • create:        executeKw(conn, uid, 'res.partner', 'create', [{ name:'X', email:'x@y' }])
 *   • write:         executeKw(conn, uid, 'res.partner', 'write', [[id], { phone:'+39...' }])
 *   • unlink:        executeKw(conn, uid, 'res.partner', 'unlink', [[id]])
 *   • metodo custom: executeKw(conn, uid, 'sale.order', 'action_confirm', [[orderId]])
 *
 * `args` positional, `kwargs` keyword (entrambi obbligatori dal lato Odoo,
 * passa `{}` se non serve).
 */
export async function executeKw<T = unknown>(
  conn: OdooConnection,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  return jsonRpcCall<T>(conn.url, 'object', 'execute_kw', [
    conn.db,
    uid,
    conn.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}
