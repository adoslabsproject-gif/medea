/**
 * Odoo XML-RPC client — pure encoder/decoder + HTTP transport contract.
 *
 * Why XML-RPC (and not JSON-RPC)
 * ──────────────────────────────
 * Odoo supports both transports. We pick XML-RPC because:
 *   1. It's the documented stable API (the "ORM External" public contract).
 *   2. JSON-RPC routes through the Odoo session middleware — that path
 *      requires CSRF tokens on writes when called from a browser context,
 *      which complicates server-to-server use. XML-RPC bypasses the
 *      session entirely.
 *   3. Every Odoo version since 8.0 has the XML-RPC endpoint enabled by
 *      default at /xmlrpc/2/. JSON-RPC is sometimes disabled in hardened
 *      installs.
 *
 * The two endpoints we use
 * ────────────────────────
 *   POST /xmlrpc/2/common   — `authenticate(db, username, password, {}) → uid`
 *   POST /xmlrpc/2/object   — `execute_kw(db, uid, password, model, method, args, kwargs) → result`
 *
 * Authentication caching
 * ──────────────────────
 * Each `authenticate` call hits the Odoo auth controller, which performs a
 * password check + a database query. Cheap, but not free. We cache uids
 * keyed by `(baseUrl, db, login, hashed-password)` with a 5-min TTL so
 * back-to-back nodes in the same workflow run share the same uid without
 * re-authenticating. Cache lives in-process; cross-tenant isolation is
 * the responsibility of the per-tenant container.
 *
 * Type discipline
 * ───────────────
 * Odoo's XML-RPC values are strictly typed (`<int>`, `<string>`, `<double>`,
 * `<boolean>`, `<dateTime.iso8601>`, `<array>`, `<struct>`, `<nil/>`).
 * We expose `OdooValue` as the union and encode/decode bidirectionally.
 * Mis-typed values (e.g. sending a JS `Date` as an `<int>`) are a runtime
 * error class; we type-check at the encoder boundary.
 *
 * Zero deps. Pure functions for encode/decode (testable on string fixtures).
 *
 * @module lib/odoo/xml-rpc-client
 */

const ERR_PREFIX = '[odoo-rpc]';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** XML-RPC value space — exact mirror of the wire format. */
export type OdooScalar = string | number | boolean | null | Date;
export type OdooValue = OdooScalar | OdooValue[] | { [key: string]: OdooValue };

export interface OdooAuth {
  baseUrl: string;          // e.g. https://my.odoo.example
  database: string;         // db name
  login: string;            // username or email
  password: string;         // password OR API key (Odoo 14+ user.api-key)
}

export interface OdooFault {
  /** Numeric XML-RPC fault code (Odoo uses 1 for "server error"). */
  faultCode: number;
  /** Server-side traceback fragment. We surface it verbatim. */
  faultString: string;
}

export class OdooFaultError extends Error {
  readonly code = 'ODOO_FAULT' as const;
  constructor(readonly fault: OdooFault) {
    super(`${ERR_PREFIX} fault ${fault.faultCode}: ${fault.faultString.split('\n')[0]}`);
    this.name = 'OdooFaultError';
  }
}

export class OdooTransportError extends Error {
  readonly code = 'ODOO_TRANSPORT' as const;
  constructor(message: string, readonly status?: number) {
    super(`${ERR_PREFIX} ${message}`);
    this.name = 'OdooTransportError';
  }
}

/**
 * Caller-supplied HTTP transport. Same shape as the streammy fetchers —
 * makes the entire client testable without monkey-patching `fetch`.
 */
export interface OdooHttpTransport {
  post(args: {
    url: string;
    body: string;                                    // XML body
    headers: Readonly<Record<string, string>>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; text: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Encoder — JS values → XML-RPC <value> string
// ────────────────────────────────────────────────────────────────────────────

/**
 * Encode a JS value to an XML-RPC `<value>...</value>` element.
 *
 * Edge cases we explicitly handle:
 *   - `null` → `<nil/>` (extension, but Odoo accepts it on the python-xmlrpc side)
 *   - `Date` → `<dateTime.iso8601>YYYYMMDDTHH:MM:SS</dateTime.iso8601>`
 *     (no `Z` suffix — that's the XML-RPC standard, NOT ISO 8601 W3C)
 *   - Integer numbers in safe range → `<int>`, else `<double>`
 *   - Non-finite numbers → throws (XML-RPC has no NaN/Infinity)
 */
export function encodeValue(v: OdooValue): string {
  if (v === null) return '<value><nil/></value>';
  if (typeof v === 'boolean') return `<value><boolean>${v ? '1' : '0'}</boolean></value>`;
  if (typeof v === 'string') return `<value><string>${escapeXml(v)}</string></value>`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new TypeError(`${ERR_PREFIX} encodeValue: ${String(v)} not encodable (XML-RPC has no NaN/Infinity)`);
    }
    if (Number.isInteger(v) && Math.abs(v) <= 2_147_483_647) {
      return `<value><int>${v}</int></value>`;
    }
    return `<value><double>${v}</double></value>`;
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new TypeError(`${ERR_PREFIX} encodeValue: invalid Date`);
    }
    return `<value><dateTime.iso8601>${formatXmlRpcDate(v)}</dateTime.iso8601></value>`;
  }
  if (Array.isArray(v)) {
    const inner = v.map(encodeValue).join('');
    return `<value><array><data>${inner}</data></array></value>`;
  }
  if (typeof v === 'object') {
    const members: string[] = [];
    for (const [k, value] of Object.entries(v)) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
      if (value === undefined) continue;
      members.push(`<member><name>${escapeXml(k)}</name>${encodeValue(value)}</member>`);
    }
    return `<value><struct>${members.join('')}</struct></value>`;
  }
  /* c8 ignore next 2 */
  throw new TypeError(`${ERR_PREFIX} encodeValue: unsupported value type ${typeof v}`);
}

/** Build a complete `<methodCall>` envelope. */
export function encodeMethodCall(method: string, params: readonly OdooValue[]): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(method)) {
    throw new TypeError(`${ERR_PREFIX} encodeMethodCall: invalid method name "${method}"`);
  }
  const paramsXml = params.map((p) => `<param>${encodeValue(p)}</param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramsXml}</params></methodCall>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Decoder — XML response → JS value
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `<methodResponse>` envelope. Returns the unwrapped value on
 * success, throws `OdooFaultError` when the response carries `<fault>`.
 *
 * We rely on the `<methodResponse>` standard layout — Odoo always emits
 * exactly one of:
 *   <methodResponse><params><param>VALUE</param></params></methodResponse>
 *   <methodResponse><fault>VALUE</fault></methodResponse>
 *
 * We're NOT a generic XML-RPC implementation; we don't tolerate multi-param
 * responses (XML-RPC spec actually forbids them too, so this is correct).
 */
export function decodeMethodResponse(xml: string): OdooValue {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new OdooTransportError('empty response body');
  }
  const trimmed = xml.trim();
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<methodResponse')) {
    throw new OdooTransportError(`response is not XML-RPC (got: ${trimmed.slice(0, 80)}...)`);
  }

  // Fault path first — order matters because a successful response may
  // legitimately contain the word "fault" inside string values.
  const faultStart = findElementStart(xml, 'fault');
  if (faultStart !== -1) {
    const valueXml = readFirstValueChildOf(xml, faultStart);
    const decoded = decodeValue(valueXml) as Record<string, OdooValue>;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    const faultCode = typeof decoded?.faultCode === 'number' ? decoded.faultCode : 0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    const faultString = typeof decoded?.faultString === 'string' ? decoded.faultString : 'unknown fault';
    throw new OdooFaultError({ faultCode, faultString });
  }

  const paramsStart = findElementStart(xml, 'params');
  if (paramsStart === -1) {
    throw new OdooTransportError('response missing both <params> and <fault>');
  }
  const valueXml = readFirstValueChildOf(xml, paramsStart);
  return decodeValue(valueXml);
}

/**
 * Decode a single `<value>...</value>` element. Internal — exposed for
 * tests but not re-exported from the package barrel.
 */
export function decodeValue(valueXml: string): OdooValue {
  const inner = extractInner(valueXml, 'value');
  if (inner === null) {
    throw new OdooTransportError(`malformed <value>: ${valueXml.slice(0, 60)}`);
  }
  const t = inner.trim();
  // Bare text (no type tag) defaults to string per XML-RPC spec
  if (!t.startsWith('<')) return unescapeXml(t);

  if (t.startsWith('<nil/>') || t.startsWith('<nil />')) return null;
  if (t.startsWith('<boolean>')) {
    return extractInner(t, 'boolean') === '1';
  }
  if (t.startsWith('<int>') || t.startsWith('<i4>')) {
    const raw = extractInner(t, t.startsWith('<i4>') ? 'i4' : 'int') ?? '';
    return parseInt(raw, 10);
  }
  if (t.startsWith('<double>')) {
    const raw = extractInner(t, 'double') ?? '';
    return parseFloat(raw);
  }
  if (t.startsWith('<string>')) {
    return unescapeXml(extractInner(t, 'string') ?? '');
  }
  if (t.startsWith('<dateTime.iso8601>')) {
    const raw = extractInner(t, 'dateTime.iso8601') ?? '';
    return parseXmlRpcDate(raw);
  }
  if (t.startsWith('<array>')) {
    const dataInner = extractInner(t, 'array');
    if (dataInner === null) return [];
    const dataBody = extractInner(dataInner, 'data') ?? '';
    return splitTopLevel(dataBody, 'value').map(decodeValue);
  }
  if (t.startsWith('<struct>')) {
    const structInner = extractInner(t, 'struct') ?? '';
    const members = splitTopLevel(structInner, 'member');
    const out: Record<string, OdooValue> = {};
    for (const m of members) {
      const name = unescapeXml(extractInner(m, 'name') ?? '');
      const valueXmlInner = readFirstValueIn(m);
      if (name.length === 0) continue;
      out[name] = decodeValue(valueXmlInner);
    }
    return out;
  }
  /* c8 ignore next 2 */
  throw new OdooTransportError(`unrecognised <value> type: ${t.slice(0, 60)}`);
}

// ────────────────────────────────────────────────────────────────────────────
// High-level client
// ────────────────────────────────────────────────────────────────────────────

const authCache = new Map<string, { uid: number; cachedAt: number }>();
const AUTH_TTL_MS = 5 * 60_000;

/**
 * Authenticate against /xmlrpc/2/common and return the user id (uid).
 * Cached for 5 min keyed by `(baseUrl|db|login|sha1(password))`.
 */
export async function authenticate(
  auth: OdooAuth,
  transport: OdooHttpTransport,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const cacheKey = `${auth.baseUrl}|${auth.database}|${auth.login}|${weakHash(auth.password)}`;
  const cached = authCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < AUTH_TTL_MS) return cached.uid;

  const body = encodeMethodCall('authenticate', [
    auth.database, auth.login, auth.password, {},
  ]);
  const url = `${stripTrailingSlash(auth.baseUrl)}/xmlrpc/2/common`;
  const fetchOpts: Parameters<OdooHttpTransport['post']>[0] = {
    url,
    body,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeoutMs: opts.timeoutMs ?? 30_000,
  };
  if (opts.signal) fetchOpts.signal = opts.signal;
  const res = await transport.post(fetchOpts);
  if (res.status < 200 || res.status >= 300) {
    throw new OdooTransportError(`authenticate HTTP ${res.status}`, res.status);
  }
  const decoded = decodeMethodResponse(res.text);
  if (typeof decoded !== 'number' || decoded === 0) {
    // Odoo returns `False` (0) on bad credentials, not a fault. Surface it
    // as a typed transport error so the workflow author sees the cause.
    throw new OdooTransportError(`authentication failed (got: ${JSON.stringify(decoded)})`);
  }
  authCache.set(cacheKey, { uid: decoded, cachedAt: Date.now() });
  return decoded;
}

/**
 * Call any model method on /xmlrpc/2/object.
 *
 *   execute_kw(model, method, [...positional], { ...keyword })
 *
 * This is the ONE entry point — every CRUD operation goes through here.
 */
export async function executeKw(
  auth: OdooAuth,
  uid: number,
  args: {
    model: string;
    method: string;
    positional?: readonly OdooValue[];
    kwargs?: Readonly<Record<string, OdooValue>>;
  },
  transport: OdooHttpTransport,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<OdooValue> {
  if (!/^[a-z][a-z0-9_.]*$/i.test(args.model)) {
    throw new TypeError(`${ERR_PREFIX} executeKw: invalid model name "${args.model}"`);
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(args.method)) {
    throw new TypeError(`${ERR_PREFIX} executeKw: invalid method name "${args.method}"`);
  }
  const body = encodeMethodCall('execute_kw', [
    auth.database,
    uid,
    auth.password,
    args.model,
    args.method,
    [...(args.positional ?? [])],
    { ...(args.kwargs ?? {}) },
  ]);
  const url = `${stripTrailingSlash(auth.baseUrl)}/xmlrpc/2/object`;
  const fetchOpts: Parameters<OdooHttpTransport['post']>[0] = {
    url,
    body,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeoutMs: opts.timeoutMs ?? 60_000,
  };
  if (opts.signal) fetchOpts.signal = opts.signal;
  const res = await transport.post(fetchOpts);
  if (res.status < 200 || res.status >= 300) {
    throw new OdooTransportError(`execute_kw HTTP ${res.status}`, res.status);
  }
  return decodeMethodResponse(res.text);
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

/** Test hook — clears the in-process auth cache. */
export function __clearOdooAuthCacheForTests(): void {
  authCache.clear();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/** `YYYYMMDDTHH:MM:SS` — XML-RPC standard. NOT ISO 8601 W3C. */
function formatXmlRpcDate(d: Date): string {
  const Y = d.getUTCFullYear().toString().padStart(4, '0');
  const M = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const D = d.getUTCDate().toString().padStart(2, '0');
  const h = d.getUTCHours().toString().padStart(2, '0');
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  const s = d.getUTCSeconds().toString().padStart(2, '0');
  return `${Y}${M}${D}T${h}:${m}:${s}`;
}

function parseXmlRpcDate(s: string): Date {
  // Accept both forms: `YYYYMMDDTHH:MM:SS` (XML-RPC) and ISO 8601 fallback.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    return new Date(Date.UTC(
      parseInt(m[1]!, 10),
      parseInt(m[2]!, 10) - 1,
      parseInt(m[3]!, 10),
      parseInt(m[4]!, 10),
      parseInt(m[5]!, 10),
      parseInt(m[6]!, 10),
    ));
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  throw new OdooTransportError(`unparseable dateTime: ${s}`);
}

function findElementStart(xml: string, tag: string): number {
  // Match `<tag>` or `<tag/>` at a word boundary.
  const re = new RegExp(`<${escapeRegex(tag)}(?:\\s+[^>]*)?(?:/?)\\s*>`);
  const m = re.exec(xml);
  return m ? m.index : -1;
}

/**
 * Find the first complete `<value>...</value>` element starting at-or-after
 * `fromIndex`, returning the entire substring (including the opening
 * `<value>` and closing `</value>` tags). Same-tag depth-aware (a lazy
 * regex breaks on nested arrays).
 */
function readFirstValueChildOf(xml: string, fromIndex: number): string {
  const span = findBalancedSpan(xml, 'value', fromIndex);
  if (!span) throw new OdooTransportError(`expected a <value> child after position ${fromIndex}`);
  return xml.slice(span.start, span.end);
}

function readFirstValueIn(memberXml: string): string {
  const span = findBalancedSpan(memberXml, 'value', 0);
  if (!span) throw new OdooTransportError('struct member missing <value>');
  return memberXml.slice(span.start, span.end);
}

/**
 * Locate the first balanced `<tag>...</tag>` span starting at-or-after
 * `fromIndex`, returning `{ start, end }` (exclusive end). Handles nested
 * same-tag elements via depth tracking. Returns null when no balanced
 * span exists.
 */
function findBalancedSpan(xml: string, tag: string, fromIndex: number): { start: number; end: number } | null {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open, fromIndex);
  if (start === -1) return null;
  const after = xml.charAt(start + open.length);
  if (after !== '>' && after !== '/' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r') {
    return null;
  }
  const lt = xml.indexOf('>', start);
  if (lt === -1) return null;
  // Self-closing form `<tag/>` → span is just the self-closing tag.
  if (xml.charAt(lt - 1) === '/') return { start, end: lt + 1 };

  let depth = 1;
  let cursor = lt + 1;
  while (cursor < xml.length && depth > 0) {
    const nextOpen = xml.indexOf(open, cursor);
    const nextClose = xml.indexOf(close, cursor);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const ch = xml.charAt(nextOpen + open.length);
      if (ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        depth += 1;
      }
      cursor = nextOpen + open.length;
    } else {
      depth -= 1;
      if (depth === 0) return { start, end: nextClose + close.length };
      cursor = nextClose + close.length;
    }
  }
  return null;
}

/**
 * Extract the inner text of the FIRST `<tag>...</tag>` occurrence in `xml`,
 * matching same-tag nesting via depth tracking.
 *
 * Why we can't use a lazy regex (`[\\s\\S]*?`):
 *   `<value><array><data><value>x</value></data></array></value>`
 *   `extractInner(_, 'value')` with lazy regex would close at the INNER
 *   `</value>`, returning `<array><data>` (broken). The depth walk gives
 *   us the correct top-level close.
 *
 * Returns null when the tag is absent OR self-closing (`<tag/>`).
 */
function extractInner(xml: string, tag: string): string | null {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const startIdx = xml.indexOf(open);
  if (startIdx === -1) return null;
  // Reject `<tag-foo` false positive: next char must be `>`, `/`, or whitespace.
  const after = xml.charAt(startIdx + open.length);
  if (after !== '>' && after !== '/' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r') return null;
  // Self-closing form `<tag/>` → null (no inner text).
  const lt = xml.indexOf('>', startIdx);
  if (lt === -1) return null;
  if (xml.charAt(lt - 1) === '/') return null;

  let depth = 1;
  let cursor = lt + 1;
  while (cursor < xml.length && depth > 0) {
    const nextOpen = xml.indexOf(open, cursor);
    const nextClose = xml.indexOf(close, cursor);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Only count it as a nested open if it's REALLY the same tag boundary.
      const ch = xml.charAt(nextOpen + open.length);
      if (ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        depth += 1;
      }
      cursor = nextOpen + open.length;
    } else {
      depth -= 1;
      if (depth === 0) return xml.slice(lt + 1, nextClose);
      cursor = nextClose + close.length;
    }
  }
  return null;
}

/**
 * Split a body into top-level `<tag>...</tag>` chunks. Used to walk
 * `<data>` (children = `<value>`) and `<struct>` (children = `<member>`).
 * Cheap depth-tracking parser — no real XML DOM.
 */
function splitTopLevel(xml: string, tag: string): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf(open, i);
    if (start === -1) break;
    const lt = xml.indexOf('>', start);
    if (lt === -1) break;
    // Scan forward tracking nested same-tag opens to find the matching close.
    let depth = 1;
    let cursor = lt + 1;
    while (cursor < xml.length && depth > 0) {
      const nextOpen = xml.indexOf(open, cursor);
      const nextClose = xml.indexOf(close, cursor);
      if (nextClose === -1) return out;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + open.length;
      } else {
        depth -= 1;
        cursor = nextClose + close.length;
      }
    }
    out.push(xml.slice(start, cursor));
    i = cursor;
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Deterministic non-cryptographic hash for the cache key. We do NOT use
 * sha256 here — the cache key never leaves this process, and a strong hash
 * would require the `crypto` import which adds tree-shake cost.
 */
function weakHash(s: string): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
