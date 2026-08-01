import type { NodeModule, NodeExecutor } from '@flowforge/nodes-stdlib';
import { readJsonCapped, readTextTruncated } from '@flowforge/safe-fetch';
import { assertSelectOnly } from './select-only-guard.js';

// Isomorfico: importato anche dal bundle browser dell'editor (dead-code lì, ma
// il top-level gira a load). `process` esiste solo sul runtime server → guard.
const RUNTIME_BASE = (typeof process !== 'undefined' ? process.env.FLOWFORGE_RUNTIME_URL : undefined) ?? 'http://127.0.0.1:3100';

function reqString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`db node: missing required config "${name}"`);
  }
  return value;
}

/**
 * SECURITY: il databaseId (config dell'autore) viene interpolato nel path di un URL
 * verso l'API INTERNA (`/api/v1/db/databases/<id>/…`) chiamata con X-Internal-Token
 * privilegiato. Senza validazione, un valore come `../../internal/egress` normalizza
 * il path e colpisce endpoint interni col token interno (privilege escalation).
 * Allowlist stretta (formato reale degli id D1 = hex/uuid/nanoid) + encodeURIComponent
 * a valle nel path (difesa-in-profondità).
 */
function reqDatabaseId(value: unknown): string {
  const id = reqString(value, 'databaseId');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('db node: databaseId non valido (ammessi solo lettere, numeri, - e _)');
  }
  return id;
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  if (value.trim() === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────
// SANDBOX GUARD — N2 audit (2026-05-29).
//
// Identici a apps/flowforge-runtime/src/engine/interpreter.ts. Manteniamo
// in-file (no shared package) per evitare cross-package coupling in un
// nodo che gia\` parla solo via HTTP REST. Quando un terzo posto avra\`
// bisogno della stessa guard, promuovere a `@flowforge/expression-guard`.
//
// Bypass coperti: Unicode escape `eval`, hex `\x65val`, bracket
// string lookup `["constructor"]`, concatenation `["co"+"de"]`, plus
// dangerous identifiers (eval/Function/process/require/import/fetch/
// setTimeout/setInterval/setImmediate/globalThis/global/AsyncFunction/
// GeneratorFunction/__proto__/constructor).
// ─────────────────────────────────────────────────────────────────────
// DEVE restare un SUPERSET di engine/interpreter.ts FORBIDDEN_IDENTIFIERS (è una
// copia: il guard del sandbox `new Function` è lì la fonte canonica). Proxy /
// Reflect / WeakRef erano stati aggiunti all'interpreter ma NON a questa copia
// (drift) → erano usabili in catene di sandbox-escape da childRowsExpression.
// Anti-drift garantito dal parity test (forbidden-identifiers.parity.test.ts).
const DB_FORBIDDEN_IDENTIFIERS = [
  'eval', 'Function', 'globalThis', 'global', 'process', 'require', 'import',
  '__proto__', 'constructor', 'AsyncFunction', 'GeneratorFunction',
  'fetch', 'setTimeout', 'setInterval', 'setImmediate',
  'Proxy', 'Reflect', 'WeakRef',
];
const DB_FORBIDDEN_REGEX: RegExp[] = [
  ...DB_FORBIDDEN_IDENTIFIERS.map((id) => new RegExp(`\\b${id}\\b`)),
  ...DB_FORBIDDEN_IDENTIFIERS.map(
    (id) => new RegExp(`\\[\\s*['"\`]${id}['"\`]\\s*\\]`),
  ),
  /\[\s*['"`][^'"`]*['"`]\s*\+/,
];
function dbDecodeEscapesForCheck(s: string): string {
  let out = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  out = out.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  out = out.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return out;
}
function dbAssertSafeExpression(expression: string): void {
  if (expression.length > 4000) {
    throw new Error('db_insert_batch: childRowsExpression exceeds 4000 character limit');
  }
  const decoded = dbDecodeEscapesForCheck(expression);
  for (const p of DB_FORBIDDEN_REGEX) {
    if (p.test(decoded) || p.test(expression)) {
      throw new Error(
        `db_insert_batch: childRowsExpression contains forbidden token matching ${p.toString()}`,
      );
    }
  }
}

/**
 * Default timeout per call DB. Coperto da CIRCUIT BREAKER lato runtime ma
 * il client HTTP qui deve avere il proprio cap — senza, una DB lenta
 * bloccherebbe il run (e il sweeper run-inflight) indefinitamente.
 *
 * 30s e\` il sweet-spot: copre 99% delle query/insert (analytics rare a parte),
 * ma il run non si impalla se la DB ha problemi.
 * Override per-nodo via config.timeoutMs (cap 300s hard).
 */
const DB_DEFAULT_TIMEOUT_MS = 30_000;
const DB_MAX_TIMEOUT_MS = 300_000;
// db_query: cap righe quando l'utente non specifica un limit (anti-OOM). Onora il
// defaultValue '100' della UI; max allineato al server (QuerySpec max 10000).
const DB_QUERY_DEFAULT_LIMIT = 100;
const DB_QUERY_MAX_LIMIT = 10_000;

function resolveTimeout(config: unknown): number {
  const raw = (config as Record<string, unknown>)?.timeoutMs;
  if (raw === undefined || raw === null || raw === '') return DB_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DB_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), DB_MAX_TIMEOUT_MS);
}

async function callDbApi<T>(path: string, body: unknown, tenantId: string, timeoutMs = DB_DEFAULT_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenantId,
  };
  const internalToken = process.env.FLOWFORGE_INTERNAL_TOKEN;
  if (internalToken) headers['X-Internal-Token'] = internalToken;

  // AbortSignal.timeout fa abort della fetch al cap → niente run hang.
  // Pattern stesso di safeFetchWithRedirects + httpExecutor.
  let res: Response;
  try {
    res = await fetch(`${RUNTIME_BASE}/api/v1/db${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`db API timeout dopo ${String(timeoutMs)}ms — DB lenta o stallata. Aumenta config.timeoutMs (cap ${String(DB_MAX_TIMEOUT_MS / 1000)}s) o verifica salute della database.`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`db API ${String(res.status)}: ${(await readTextTruncated(res, 8192)).text.slice(0, 400)}`);
  }
  // anti-OOM: un SELECT senza LIMIT può tornare un result-set enorme.
  return (await readJsonCapped(res));
}

const queryExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const databaseId = reqDatabaseId(config.databaseId);
  const table = reqString(config.table, 'table');
  const filters = jsonParse<{ column?: unknown; op?: unknown; value?: unknown }[]>(config.filtersJson, []);
  // Reject filters where `column` matches a literal schema placeholder name.
  // Catches the "import shipped with default placeholders" bug pattern:
  // a JSON like `{column:"column", op:"eq", value:"vendor_code"}` reaches the
  // DB and crashes with "no such column 'column'" — confusing for the user.
  // Better to fail fast with a clear error.
  const PLACEHOLDER_COLUMN_NAMES = new Set(['column', 'op', 'value']);
  for (const f of filters) {
    const col = typeof f?.column === 'string' ? f.column.trim() : '';
    if (PLACEHOLDER_COLUMN_NAMES.has(col.toLowerCase())) {
      throw new Error(
        `db_query: filtro malformato — column="${col}" è un nome segnaposto. ` +
        `Verifica che il filtersJson sia stato compilato correttamente (column dovrebbe essere il nome di una colonna reale della tabella).`,
      );
    }
  }
  const select = jsonParse<string[]>(config.selectJson, []);
  const orderBy = jsonParse(config.orderByJson, []);
  // LIMIT SEMPRE applicato (anti-OOM): la UI mostra defaultValue '100' ma l'executor
  // NON lo applicava quando il campo era vuoto → spec senza limit → il server ritorna
  // TUTTE le righe → OOM su tabelle grandi (fix 2026-06-17, era aspirazionale).
  // Onora il default UI (100) e clampa al max server (10000).
  const rawLimit = config.limit !== undefined && config.limit !== '' ? Number(config.limit) : NaN;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), DB_QUERY_MAX_LIMIT) : DB_QUERY_DEFAULT_LIMIT;
  const offset = config.offset !== undefined ? Number(config.offset) : undefined;

  const spec: Record<string, unknown> = { table, filters, orderBy, limit };
  if (select.length > 0) spec.select = select;
  if (offset !== undefined && !Number.isNaN(offset)) spec.offset = offset;

  const result = await callDbApi<{ rows: unknown[]; rowCount: number }>(
    `/databases/${encodeURIComponent(databaseId)}/query`,
    spec,
    context.tenantId,
    resolveTimeout(config),
  );
  return { output: result, durationMs: Date.now() - start };
};

const insertExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const databaseId = reqDatabaseId(config.databaseId);
  const table = reqString(config.table, 'table');
  let row: Record<string, unknown>;
  if (config.rowJson) {
    row = jsonParse<Record<string, unknown>>(config.rowJson, {});
  } else if (input && typeof input === 'object') {
    row = input as Record<string, unknown>;
  } else {
    throw new Error('db_insert: provide rowJson or pipe a JSON object as input');
  }
  // onConflict semantics for retry-safety. 'fail' (default) preserves the
  // historical INSERT behavior — UNIQUE/PK collisions surface as errors so
  // the operator notices duplicates. 'ignore' is the right choice for
  // idempotency markers (mark_processed: re-running the same workflow on
  // the same email should be a no-op, not a UNIQUE violation). 'update' is
  // a true upsert — replace existing row by primary key.
  const onConflict = typeof config.onConflict === 'string' ? config.onConflict : 'fail';
  try {
    const result = await callDbApi(`/databases/${encodeURIComponent(databaseId)}/insert`, { table, row }, context.tenantId, resolveTimeout(config));
    return { output: result, durationMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (onConflict === 'ignore' && /UNIQUE|duplicate|PRIMARY KEY|already exists/i.test(msg)) {
      // Idempotent path: row already there. Surface a structured result so
      // downstream nodes can branch on it if needed, but DO NOT throw.
      return { output: { ok: true, alreadyExisted: true, table }, durationMs: Date.now() - start };
    }
    throw err;
  }
};

export const dbQueryNode: NodeModule = {
  def: {
    id: 'db_query',
    type: 'action',
    label: 'DB: Query',
    icon: 'database',
    color: '#0ea5e9',
    description:
      'Esegue una SELECT su tabella di un database FlowForge-managed con filtri visuali (WHERE), colonne, ordinamento e limit. ' +
      'I filtri vengono combinati in AND (operatori per tipo: eq/neq/gt/lt/contains/in/is-null). ' +
      'Supporta paginazione via limit + offset. Output: array di rows. ' +
      'Use case: lookup record per ID/email, scan filtrato per cron, report KPI dashboard, ' +
      'join soft-coded in JS post-query. Per query complesse (JOIN/CTE/GROUP BY) usa db_sql_query.',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'table', label: 'Tabella', type: 'db-table-picker', required: true, dependsOn: 'databaseId' },
      { key: 'filtersJson', label: 'Filtri (WHERE)', type: 'filter-rows', required: false, help: 'Tutti i filtri sono combinati in AND. Lascia vuoto per nessun WHERE.' },
      { key: 'selectJson', label: 'Colonne da selezionare', type: 'chip-list', required: false, help: 'Vuoto = SELECT *. Aggiungi i nomi delle colonne.' },
      { key: 'orderByJson', label: 'Ordina per (ORDER BY)', type: 'sort-rows', required: false, help: 'Aggiungi una o più colonne. La prima è l\'ordinamento primario.' },
      { key: 'limit', label: 'Limit', type: 'number', required: false, defaultValue: '100' },
      { key: 'offset', label: 'Offset', type: 'number', required: false },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: queryExecutor,
};

export const dbInsertNode: NodeModule = {
  def: {
    id: 'db_insert',
    type: 'action',
    label: 'DB: Insert',
    icon: 'plus-square',
    color: '#0ea5e9',
    description:
      'INSERT di una riga in una tabella. Dati passati via config key-value (con {{espressioni}}) o piped dal nodo precedente. ' +
      'Supporta onConflict policy: "fail" (default, raise error su PK/UNIQUE collision — protegge da duplicati indesiderati) o "ignore" (skip silente — utile per dedup table marker idempotenti come processed_emails/processed_webhooks). ' +
      'Output: { id, inserted: true } o { skipped: true } se onConflict=ignore + collision. ' +
      'Use case: log eventi, salvare lead/contatti, marker idempotenti, inserimento dati da form/CSV.',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'table', label: 'Tabella', type: 'db-table-picker', required: true, dependsOn: 'databaseId' },
      { key: 'rowJson', label: 'Dati riga', type: 'key-value', required: false, help: 'Coppie colonna=valore. Vuoto = usa l\'input del nodo precedente come riga. Supporta {{espressioni}}.' },
      { key: 'onConflict', label: 'Se la riga esiste già', type: 'select', options: ['fail', 'ignore'], required: false, defaultValue: 'fail', help: '"fail" (raccomandato per dati di business): se la riga c\'è già, segnala errore — così ti accorgi di duplicati indesiderati (es. ordine 12345 ricevuto due volte). "ignore" (raccomandato per marker idempotenti): se la riga c\'è già, considera l\'inserimento già fatto e continua senza errore — utile per tabelle "dedup" come processed_emails / processed_webhooks dove ri-eseguire lo stesso evento è normale e atteso.' },
    ],
    vendor: 'flowforge',
    version: '1.2.0',
  },
  executor: insertExecutor,
};

export const dbUpdateNode: NodeModule = {
  def: {
    id: 'db_update',
    type: 'action',
    label: 'DB: Update',
    icon: 'edit',
    color: '#0ea5e9',
    description:
      'UPDATE righe matching un where clause (key-value). Patch via campi key-value con supporto {{espressioni}}. ' +
      'TUTTE le condizioni WHERE in AND (anti-update accidentale di tabella intera). Se where vuoto → errore (safety). ' +
      'Output: { updatedCount, rows? }. ' +
      'Use case: aggiornare status ordine (paid/shipped), mark email as read, increment counter, sync field da API esterna.',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'table', label: 'Tabella', type: 'db-table-picker', required: true, dependsOn: 'databaseId' },
      { key: 'whereJson', label: 'Riga da aggiornare (WHERE)', type: 'key-value', required: true, help: 'Coppie chiave-valore: la riga deve matchare tutte. Es. id = 42.' },
      { key: 'patchJson', label: 'Campi da modificare', type: 'key-value', required: true, help: 'Coppie chiave-valore dei campi da aggiornare. Supporta {{espressioni}}.' },
    ],
    // Discoverability: il nodo canonico per "aggiornare un record" nel DB.
    // Robusto contro la diluizione da nuovi nodi DB (golden eval recall@10).
    searchAliases: ['aggiorna record', 'aggiorna riga', 'aggiorna un record nel database', 'modifica record', 'modifica riga', 'update record', 'update row', 'aggiornare dati nel database'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const dbDeleteNode: NodeModule = {
  def: {
    id: 'db_delete',
    type: 'action',
    label: 'DB: Delete',
    icon: 'trash-2',
    color: '#ef4444',
    description:
      'DELETE righe matching un where clause. OPERAZIONE DISTRUTTIVA: richiede flag confirmDelete=true per evitare misclick. ' +
      'TUTTE le condizioni WHERE in AND. Where vuoto → errore (safety, anti-truncate). ' +
      'Output: { deletedCount }. ' +
      'Use case: cleanup expired sessions, soft-delete con flag invece di DELETE fisica (consigliato), purga dati scaduti GDPR. ' +
      'ATTENZIONE: per audit_log usa il sistema cold-storage (DELETE bloccato da trigger).',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'table', label: 'Tabella', type: 'db-table-picker', required: true, dependsOn: 'databaseId' },
      { key: 'whereJson', label: 'Righe da eliminare (WHERE)', type: 'key-value', required: true, help: 'Coppie chiave-valore: la riga deve matchare tutte per essere eliminata.' },
      { key: 'confirmDelete', label: 'Confermo che questa operazione è distruttiva', type: 'boolean', required: true, defaultValue: 'false' },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

/**
 * Atomic batch: header row + N children in ONE transaction. Either everything
 * commits or nothing does. Solves the "orphan order header" problem when the
 * children INSERT fails halfway through.
 *
 *   Config shape:
 *     databaseId    — picker
 *     headerTable   — string (es. "orders")
 *     headerRowJson — JSON object (es. {"order_number":"2600070","supplier_code":"F000000139",...})
 *     childTable    — string (es. "order_lines")
 *     childRowsExpression — JS expression that returns an array of row objects.
 *                           Receives `input` and `output` in scope.
 *     refColumn     — name of FK column on the child table (es. "order_id")
 *
 *   Output: { headerId, childCount, durationMs }
 */
const insertBatchExecutor: NodeExecutor = async (config, input, context) => {
  const start = Date.now();
  const databaseId = reqDatabaseId(config.databaseId);
  const headerTable = reqString(config.headerTable, 'headerTable');
  const childTable = reqString(config.childTable, 'childTable');
  const refColumn = reqString(config.refColumn, 'refColumn');

  const headerRow = jsonParse<Record<string, unknown>>(config.headerRowJson, {});
  if (Object.keys(headerRow).length === 0) {
    throw new Error('db_insert_batch: headerRowJson is empty');
  }

  // Resolve child rows. If the user provided a literal JSON array, use it.
  // Otherwise evaluate the expression against `input` (typical case: a
  // previous LLM step produced { lines: [...] } and the user types
  // `input.lines`).
  let childRows: Record<string, unknown>[];
  const childExpr = typeof config.childRowsExpression === 'string' ? config.childRowsExpression.trim() : '';
  if (childExpr.startsWith('[')) {
    childRows = jsonParse<Record<string, unknown>[]>(childExpr, []);
  } else if (childExpr) {
    // Sandbox vars: `input` (output of previous node), `output` (alias of input
    // for back-compat) and `$node` (map of all prior node outputs keyed by id
    // AND by alias — same shape used by `{{$node.X.json.Y}}` interpolation).
    // Two rewrites, matching the template interpreter behaviour:
    //   1) `$node.<X>.json.Y` → `_node["<X>"].Y`  (the `.json` is conventional
    //      sugar that gets stripped — the value is the raw node output)
    //   2) `$node.<X>` (no `.json`) → `_node["<X>"]` — back-compat
    const sandboxedExpr = childExpr
      .replace(/\$node\.([a-zA-Z0-9_-]+)\.json/g, '_node["$1"]')
      .replace(/\$node\.([a-zA-Z0-9_-]+)/g, '_node["$1"]');
    // N2 audit (2026-05-29): controlla forbidden tokens (eval, Function,
    // process, require, ecc.) PRIMA del new Function — Unicode/hex escape
    // decode incluso. Stesso guard di apps/.../engine/interpreter.ts.
    dbAssertSafeExpression(sandboxedExpr);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('input', 'output', '_node', `return (${sandboxedExpr});`) as (i: unknown, o: unknown, n: unknown) => unknown;
    const raw = fn(input, input, context.nodeOutputs ?? {});
    if (!Array.isArray(raw)) {
      throw new Error(`db_insert_batch: childRowsExpression must return an array, got ${typeof raw}`);
    }
    childRows = raw as Record<string, unknown>[];
  } else {
    // Fallback: input.lines convention.
    const inputObj = (input ?? {}) as { lines?: unknown };
    if (!Array.isArray(inputObj.lines)) {
      throw new Error('db_insert_batch: provide childRowsExpression or pipe { lines: [...] } from the previous node');
    }
    childRows = inputObj.lines as Record<string, unknown>[];
  }

  // Strip "skipColumns" (default: line_total + net_price + altri pattern di
  // colonne tipicamente GENERATED in DB SQL). Se l'utente fornisce una
  // lista comma-separated, viene rispettata. Altrimenti usiamo una blacklist
  // ragionevole che copre il 90% dei casi tipici (Italian procurement ETL).
  const skipColumns = (typeof config.skipColumns === 'string' && config.skipColumns.trim() !== ''
    ? config.skipColumns.split(',').map((s) => s.trim()).filter(Boolean)
    : ['line_total', 'net_price', 'price_discrepancy_flag']);
  if (skipColumns.length > 0) {
    childRows = childRows.map((row) => {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!skipColumns.includes(k)) filtered[k] = v;
      }
      return filtered;
    });
  }
  // Stesso filtro per headerRow (potrebbe avere id auto-generato o
  // colonne calcolate). Conservative — applica skipColumns anche qui.
  if (skipColumns.length > 0) {
    for (const k of skipColumns) delete (headerRow)[k];
  }

  // Idempotency mode: if onConflict='ignore', a UNIQUE/PK collision on the
  // header insert turns into a soft no-op (we return the headerId of the
  // existing row instead of crashing the workflow). Critical for "ricevo la
  // stessa email due volte" scenarios. NB: when the header already exists,
  // we DO NOT re-insert the child rows — they're already linked.
  const onConflict = typeof config.onConflict === 'string' ? config.onConflict : 'fail';
  try {
    const result = await callDbApi<{ steps: { affectedRows: number; insertedId?: number }[]; bindings: Record<string, number>; durationMs: number }>(
      `/databases/${encodeURIComponent(databaseId)}/transaction`,
      {
        ops: [
          { kind: 'insert', table: headerTable, row: headerRow, as: 'headerId' },
          { kind: 'insertMany', table: childTable, rows: childRows, refColumn, refFrom: 'headerId' },
        ],
      },
      context.tenantId,
      resolveTimeout(config),
    );
    return {
      output: {
        headerId: result.bindings.headerId,
        childCount: result.steps[1]?.affectedRows ?? 0,
        headerTable,
        childTable,
        alreadyExisted: false,
      },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (onConflict === 'ignore' && /UNIQUE|duplicate|PRIMARY KEY|already exists/i.test(msg)) {
      // Soft no-op: the header (and presumably its children) already exist.
      // CRITICAL: we MUST resolve and return the existing headerId, otherwise
      // any downstream node that uses `{{$node.save_X.json.headerId}}` (e.g.
      // mark_processed linking via FK) crashes with FOREIGN KEY constraint
      // failed. Strategy: query the header table back, using the UNIQUE-key
      // fields from the headerRow we tried to insert. SQLite/PostgreSQL: pick
      // ALL columns from headerRow whose value is primitive (string/number)
      // and build a WHERE that uniquely identifies the row.
      let existingHeaderId: unknown = null;
      try {
        const conditions: { column: string; op: 'eq'; value: string | number }[] = [];
        for (const [k, v] of Object.entries(headerRow)) {
          if (typeof v === 'string' || typeof v === 'number') {
            conditions.push({ column: k, op: 'eq', value: v });
          }
        }
        if (conditions.length > 0) {
          const queryResult = await callDbApi<{ rows: Record<string, unknown>[] }>(
            `/databases/${encodeURIComponent(databaseId)}/query`,
            { table: headerTable, conditions, limit: 1 },
            context.tenantId,
            resolveTimeout(config),
          );
          if (queryResult.rows.length > 0) {
            // Convention: primary key is `id`. If a tenant uses a different
            // PK name they can override via config.headerIdColumn (future).
            existingHeaderId = queryResult.rows[0]?.id ?? null;
          }
        }
      } catch {
        // Best-effort: if the lookup fails (e.g. column mismatch), we still
        // return alreadyExisted:true but headerId stays null. Downstream
        // nodes referencing headerId will then fail loudly — better than
        // silently corrupting FK references.
      }
      return {
        output: {
          alreadyExisted: true,
          headerId: existingHeaderId,
          headerTable,
          childTable,
          childCount: 0,
          note: existingHeaderId
            ? `Header già presente con la stessa chiave UNIQUE — INSERT saltato. headerId esistente: ${typeof existingHeaderId === 'string' || typeof existingHeaderId === 'number' || typeof existingHeaderId === 'bigint' ? existingHeaderId : JSON.stringify(existingHeaderId)}`
            : 'Header già presente ma impossibile risolvere headerId esistente (chiave non univoca o ricerca fallita). Downstream FK lookups falliranno.',
        },
        durationMs: Date.now() - start,
      };
    }
    throw err;
  }
};

export const dbInsertBatchNode: NodeModule = {
  def: {
    id: 'db_insert_batch',
    type: 'action',
    label: 'DB: Insert Batch (header + figli, atomico)',
    icon: 'layers',
    color: '#0ea5e9',
    description:
      'Inserisce in modo ATOMICO un header (es. ordine) + N righe figlie (es. order_lines), tutto in una transazione singola. ' +
      'Se l\'inserzione delle righe fallisce, anche l\'header viene rollbackato — niente ordini fantasma in DB. ' +
      'Tipico per: orders+order_lines, invoices+invoice_lines, deliveries+delivery_items.',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'headerTable', label: 'Tabella header', type: 'db-table-picker', required: true, dependsOn: 'databaseId', help: 'Es. "orders". 1 riga inserita.' },
      {
        key: 'headerRowJson',
        label: 'Header row (JSON)',
        type: 'code',
        language: 'json',
        required: true,
        placeholder: '{\n  "order_number": "{{input.order_number}}",\n  "supplier_code": "{{input.supplier_code}}"\n}',
        help: 'JSON object con le colonne dell\'header. Espressioni {{}} risolte runtime.',
      },
      { key: 'childTable', label: 'Tabella children', type: 'db-table-picker', required: true, dependsOn: 'databaseId', help: 'Es. "order_lines". N righe inserite.' },
      {
        key: 'childRowsExpression',
        label: 'Espressione array children',
        type: 'expression',
        required: true,
        placeholder: 'input.lines',
        help: 'Espressione JS che ritorna l\'array di righe figlie. Esempi: input.lines · input.order_lines · output.items. Riceve `input` (output del nodo precedente).',
      },
      {
        key: 'refColumn',
        label: 'Colonna FK (children → header)',
        type: 'text',
        required: true,
        placeholder: 'order_id',
        help: 'Nome della colonna sul child che riferisce l\'id dell\'header. Es. "order_id" se order_lines.order_id REFERENCES orders.id.',
      },
      {
        key: 'onConflict',
        label: 'Se l\'header esiste già',
        type: 'select',
        options: ['fail', 'ignore'],
        required: false,
        defaultValue: 'fail',
        help: '"fail" (default): se l\'header viola un UNIQUE/PK, errore (utile per accorgersi di duplicati indesiderati). "ignore": se l\'header esiste già, salta l\'intero batch atomico e ritorna { alreadyExisted: true } — utile per workflow ricevuti più volte sullo stesso input (es. webhook con retry, email duplicate).',
      },
      {
        key: 'skipColumns',
        label: 'Colonne da NON inserire (comma-separated)',
        type: 'text',
        required: false,
        defaultValue: 'line_total,net_price,price_discrepancy_flag',
        help: 'Lista di nomi colonna da rimuovere prima del INSERT. Tipicamente colonne GENERATED in DB SQL (es. line_total REAL GENERATED ALWAYS AS qty*price*(1-discount)) che il DB rifiuta di accettare in INSERT. Default coprono il 90% dei casi italian-procurement. Aggiungere/togliere secondo schema reale del tuo DB.',
      },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
  executor: insertBatchExecutor,
};

export const dbSubscribeNode: NodeModule = {
  def: {
    id: 'db_subscribe',
    type: 'trigger',
    label: 'DB: Subscribe (changes)',
    icon: 'radio',
    color: '#22c55e',
    description:
      'Esegue il workflow quando una riga viene insert/update/delete in una tabella FlowForge DB (real-time subscribe). ' +
      'Filtri opzionali per condition match (es. status=active AND amount>100 — trigger solo per righe interessanti). ' +
      'Input al workflow: { event: insert|update|delete, row, oldRow?, table }. ' +
      'Use case: notifica admin su nuovi ordini, sync esterno post-update CRM, audit trail su tabelle sensibili, ' +
      'dashboard real-time KPI senza polling.',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'table', label: 'Tabella', type: 'db-table-picker', required: true, dependsOn: 'databaseId' },
      { key: 'events', label: 'Eventi da monitorare', type: 'select', required: true, options: ['insert', 'update', 'delete', 'all'], defaultValue: 'all', help: 'all = qualsiasi cambio. Combinazioni custom non supportate qui — usa 2 trigger separati se serve.' },
      { key: 'filtersJson', label: 'Filtri righe', type: 'filter-rows', required: false, help: 'Trigger solo quando la riga matcha questi filtri (es. status=active AND amount>100).' },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

/**
 * db_sql_query — execute a SELECT statement against a tenant database and
 * return rows. Unlike db_query (which is field-based and limited to single-
 * table), this node accepts arbitrary SQL — supports JOIN, GROUP BY, CTE,
 * aggregations. The catch: the executor enforces SELECT-only at the START
 * of the trimmed statement; anything else (INSERT/UPDATE/DELETE/DDL) is
 * rejected by the server (executeRaw is permissive but THIS node refuses
 * to forward non-SELECT). Use db_insert/db_update for mutations.
 *
 * Critical for the "rolling Excel" pattern: 1 query JOIN orders+order_lines+
 * suppliers, results passed straight to action_xlsx_build with groupByKey
 * for multi-sheet layout.
 */
const sqlQueryExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const databaseId = reqDatabaseId(config.databaseId);
  const sql = reqString(config.sql, 'sql').trim();
  const rowLimit = config.rowLimit !== undefined ? Number(config.rowLimit) : 5000;

  // Guard SELECT-only ROBUSTO (security): non basta controllare la prima keyword
  // — un CTE data-modifying (`WITH x AS (DELETE …) SELECT …`) o un multi-statement
  // (`SELECT 1; DELETE …`) bypasserebbero un check leading-only e MUTEREBBERO dati
  // in un nodo "sola lettura". assertSelectOnly lavora su skeleton senza
  // stringhe/commenti, rifiuta i ; interni e ogni keyword DML/DDL ovunque.
  assertSelectOnly(sql);

  const result = await callDbApi<{ statementResults?: { rows?: unknown[] }[]; rows?: unknown[]; rowCount?: number; durationMs?: number }>(
    `/databases/${encodeURIComponent(databaseId)}/sql`,
    { sql, dryRun: false, rowLimit },
    context.tenantId,
    resolveTimeout(config),
  );
  // executeRaw returns statementResults[]; collapse to a single rows array
  // for compatibility with downstream action_xlsx_build / loop nodes.
  const rows = (result.statementResults?.[0]?.rows ?? result.rows ?? []) as Record<string, unknown>[];
  return {
    output: { rows, rowCount: rows.length, durationMs: result.durationMs ?? Date.now() - start },
    durationMs: Date.now() - start,
  };
};

export const dbSqlQueryNode: NodeModule = {
  def: {
    id: 'db_sql_query',
    type: 'action',
    label: 'DB: SQL Query (custom SELECT)',
    icon: 'database',
    color: '#0284c7',
    description:
      'Esegue una SELECT custom SQL (con JOIN, GROUP BY, CTE WITH, aggregations, subquery) e ritorna le righe. ' +
      'SOLO LETTURA: guard server-side rejecta INSERT/UPDATE/DELETE/DDL (per mutazioni usa db_insert/db_update/db_delete). ' +
      'Row limit configurabile (default 5000, hard cap anti-runaway). Parametrizzato anti-SQLi via Drizzle. ' +
      'Output: { rows: object[], rowCount, durationMs }. ' +
      'Use case: report multi-tabella per dashboard, analytics aggregati pre-Excel, query complesse da legacy ERP/Odoo.',
    configFields: [
      { key: 'databaseId', label: 'Database', type: 'db-picker', required: true },
      { key: 'sql', label: 'SQL (solo SELECT)', type: 'code', language: 'sql', required: true, placeholder: 'SELECT o.order_number, ol.product_description FROM orders o JOIN order_lines ol ON ol.order_id = o.id WHERE o.order_date >= date(\'now\',\'-90 days\') ORDER BY o.order_date DESC', help: 'Statement SELECT (anche con CTE/JOIN/GROUP BY). Supporta {{espressioni}} per parametri dinamici. Limite riga applicato automaticamente.' },
      { key: 'rowLimit', label: 'Limite righe', type: 'number', required: false, defaultValue: '5000', help: 'Cap di sicurezza per evitare di scaricare milioni di righe. Default 5000.' },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: sqlQueryExecutor,
};

// ─── DB esterno via tunnel SSH (DBeaver-grade) ────────────────────────────────
// def-only: l'executor (remoteSshDbQueryExecutor) è overlaid dal runtime registry
// perché usa ssh2 + connect.ts (policy/anti-rebinding) + vault (node-only).
export const dbRemoteSshQueryNode: NodeModule = {
  def: {
    id: 'db_remote_ssh_query',
    type: 'action',
    label: 'DB esterno via SSH (SELECT)',
    icon: 'database',
    color: '#7c3aed',
    description:
      'Legge da un database Postgres ESTERNO attraverso un tunnel SSH sicuro (come DBeaver). ' +
      'SOLO LETTURA (SELECT/EXPLAIN; mutazioni e multi-statement rifiutate). Host-key PINNING obbligatorio (anti-MITM), ' +
      'SSRF + anti DNS-rebinding sull\'host SSH, credenziali dal vault per-tenant (mai in chiaro nel workflow). ' +
      'Output: { rows, rowCount, durationMs }. Use case: leggere un gestionale legacy/Postgres del cliente raggiungibile solo via bastion SSH.',
    configFields: [
      { key: 'ssh', label: 'Connessione SSH', type: 'json', required: true, help: '{ host, port, user, hostKeyFingerprint, auth:{ method:"key", privateKeySecretRef } }' },
      { key: 'db', label: 'Database remoto', type: 'json', required: true, help: '{ engine:"postgres", host, port, database, userSecretRef?, passwordSecretRef? }' },
      { key: 'sql', label: 'SQL (solo SELECT)', type: 'code', language: 'sql', required: true, placeholder: 'SELECT * FROM clienti LIMIT 100' },
      { key: 'rowLimit', label: 'Limite righe', type: 'number', required: false, defaultValue: '1000' },
    ],
    // Alias SSH/remoto-specifici: si trova per "db esterno/ssh/bastion", NON per
    // le query DB generiche (es. "aggiorna un record" → resta db_update).
    searchAliases: ['ssh tunnel', 'database remoto', 'db esterno', 'postgres remoto', 'bastion ssh', 'dbeaver', 'leggi db cliente via ssh'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  // executor overlaid dal runtime (serverExecutors.db_remote_ssh_query)
};

// ─── RAG per-tenant (vector DB) ───────────────────────────────────────────────
// def-only: gli executor (ragSearchExecutor/ragIngestExecutor) sono overlaid dal
// runtime registry perché usano VectorService (isolamento per-tenant) + embedText.

export const ragSearchNode: NodeModule = {
  def: {
    id: 'rag_search',
    type: 'action',
    label: 'RAG: Cerca (vector)',
    icon: 'search',
    color: '#8b5cf6',
    description:
      'Retrieval semantico sulla knowledge base vettoriale DEL TENANT: embeddizza la query (provider a scelta — OpenAI/Voyage/Ollama, ' +
      'BYOK) e fa una KNN coseno sul vector DB selezionato, ritornando i top-k chunk più simili da passare a un nodo agente/LLM come ' +
      'contesto di grounding. Isolamento garantito: vede SOLO le collection del tenant (namespace per-database). La query arriva dal ' +
      'campo o dall\'input (stringa, {query} o {text}). Output: { query, results: [{ id, score, payload }] }. ' +
      'Use case: rispondere a domande sui documenti caricati dal tenant, FAQ aziendali, manuali, knowledge base di supporto.',
    configFields: [
      { key: 'databaseId', label: 'Vector DB', type: 'db-picker', required: true, help: 'Un database con engine vettoriale (embedded o pgvector).' },
      { key: 'collection', label: 'Collezione', type: 'text', required: true, help: 'Nome della collezione vettoriale dentro il DB.' },
      { key: 'query', label: 'Query', type: 'text', required: false, help: 'Testo da cercare. Vuoto = usa l\'input del nodo precedente (stringa o {query}/{text}). Supporta {{espressioni}}.' },
      { key: 'provider', label: 'Provider embedding', type: 'select', options: ['openai', 'voyage', 'ollama'], required: false, defaultValue: 'openai', help: 'DEVE combaciare col provider/modello usato in ingest (stesso spazio vettoriale).' },
      { key: 'model', label: 'Modello embedding', type: 'text', required: false, defaultValue: 'text-embedding-3-small', help: 'Stesso modello dell\'ingest, altrimenti i vettori non sono confrontabili.' },
      { key: 'apiKey', label: 'API key (BYOK)', type: 'text', required: false, help: 'Chiave del provider embedding (per openai/voyage). Ollama self-hosted non la richiede.' },
      { key: 'topK', label: 'Top K risultati', type: 'number', required: false, defaultValue: '5' },
      { key: 'minScore', label: 'Similarità minima (0-1)', type: 'number', required: false, help: 'Scarta i risultati sotto questa soglia. Vuoto = nessuna soglia.' },
      { key: 'filterJson', label: 'Filtro payload', type: 'key-value', required: false, help: 'Coppie chiave-valore: ritorna solo i chunk col payload corrispondente.' },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const ragIngestNode: NodeModule = {
  def: {
    id: 'rag_ingest',
    type: 'action',
    label: 'RAG: Indicizza (vector)',
    icon: 'database',
    color: '#8b5cf6',
    description:
      'Indicizza un contenuto nella knowledge base vettoriale DEL TENANT: embeddizza il testo (provider a scelta, BYOK) e fa upsert nel ' +
      'vector DB selezionato, creando la collezione se non esiste (dimensioni dedotte dal modello). Idempotente: senza id esplicito ne ' +
      'genera uno deterministico dal contenuto (ri-eseguire non duplica). Il contenuto arriva dal campo o dall\'input (stringa, {content} ' +
      'o {text}). Il payload conserva sempre il testo originale per il retrieval. Isolamento: scrive SOLO nello store del tenant. ' +
      'Output: { id, upserted }. Use case: indicizzare documenti caricati, output di scraping, righe DB, email — per poi cercarli con rag_search.',
    configFields: [
      { key: 'databaseId', label: 'Vector DB', type: 'db-picker', required: true, help: 'Un database con engine vettoriale (embedded o pgvector).' },
      { key: 'collection', label: 'Collezione', type: 'text', required: true, help: 'Nome della collezione (creata se non esiste).' },
      { key: 'content', label: 'Contenuto da indicizzare', type: 'text', required: false, help: 'Testo da embeddizzare. Vuoto = usa l\'input del nodo precedente (stringa o {content}/{text}).' },
      { key: 'id', label: 'ID record', type: 'text', required: false, help: 'Vuoto = id deterministico dal contenuto (idempotenza). Fornisci un id stabile (es. {{input.docId}}) per aggiornare lo stesso record.' },
      { key: 'provider', label: 'Provider embedding', type: 'select', options: ['openai', 'voyage', 'ollama'], required: false, defaultValue: 'openai' },
      { key: 'model', label: 'Modello embedding', type: 'text', required: false, defaultValue: 'text-embedding-3-small', help: 'Le dimensioni della collezione derivano da questo modello — non cambiarlo dopo il primo ingest.' },
      { key: 'apiKey', label: 'API key (BYOK)', type: 'text', required: false },
      { key: 'distance', label: 'Distanza', type: 'select', options: ['cosine', 'euclidean', 'dot'], required: false, defaultValue: 'cosine' },
      { key: 'payloadJson', label: 'Metadati (payload)', type: 'key-value', required: false, help: 'Coppie chiave-valore salvate col chunk (es. source, lang). Il contenuto viene sempre incluso automaticamente.' },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const dbNodes: readonly NodeModule[] = [dbQueryNode, dbInsertNode, dbInsertBatchNode, dbUpdateNode, dbDeleteNode, dbSubscribeNode, dbSqlQueryNode, dbRemoteSshQueryNode, ragSearchNode, ragIngestNode] as const;
