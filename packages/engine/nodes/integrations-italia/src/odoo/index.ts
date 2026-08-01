/**
 * Odoo connector — CRUD universale + execute_kw per metodi custom.
 *
 * Stack 2026:
 *   • JSON-RPC 2.0 native (no XML-RPC legacy, no deps esterne)
 *   • UID cache 30min per connection (memoize fail-safe)
 *   • OdooError typed con odooClass extraction da error.data.name
 *   • parseJsonArg fail-fast con descriptive throw
 *   • Progressive disclosure UI: showIf field-level (utente vede SOLO i campi
 *     pertinenti all'action selezionata)
 *   • configFields tipizzati con regex/options/help inline
 *   • Idempotency-friendly (read=cacheable, write=transactional Odoo)
 *
 * Cliente target: studio_commerciale con Odoo ERP + modulo custom.
 * Architettura JSON-RPC su /jsonrpc, client in ./client.ts.
 *
 * Modelli Odoo tipici:
 *   • res.partner               clienti/fornitori
 *   • res.users                 utenti
 *   • sale.order                ordini vendita
 *   • purchase.order            ordini acquisto
 *   • account.move              fatture (out_invoice/in_invoice/out_refund)
 *   • account.move.line         righe fattura
 *   • product.product           articoli
 *   • stock.quant               giacenze
 *   • crm.lead                  opportunità CRM
 *   • <modulo_custom>.<model>   modelli del modulo proprietario cliente
 *
 * Domain syntax Odoo (polish notation):
 *   [['field', operator, value], ['field2', operator, value2]]
 *   AND implicito, OR esplicito con '|' prefix, NOT con '!' prefix
 *   Operators: =, !=, >, >=, <, <=, like, ilike, in, not in, child_of
 *
 * Esempi config workflow:
 *   action='search_read', model='res.partner',
 *   domain='[["is_company","=",true],["country_id.code","=","IT"]]',
 *   fields='["id","name","vat","email"]', limit='100'
 *
 *   action='execute_method', model='sale.order', method='action_confirm',
 *   args='[[42]]'  → conferma ordine ID 42 chiamando metodo Python custom
 */

import type { NodeModule } from '@flowforge/nodes-stdlib';
import {
  odooAuthenticate,
  executeKw,
  OdooError,
  type OdooConnection,
} from './client.js';

// Memoize uid per-connection (key = host+db+user). Odoo authenticate è cheap
// ma ripetuto ogni request è waste. TTL 30min — la session resta valida
// finché la password/API key non cambia.
const uidCache = new Map<string, { uid: number; expiresAt: number }>();
const UID_TTL_MS = 30 * 60_000;

async function getAuthenticatedUid(conn: OdooConnection): Promise<number> {
  const key = `${conn.url}|${conn.db}|${conn.username}`;
  const cached = uidCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.uid;
  const uid = await odooAuthenticate(conn);
  uidCache.set(key, { uid, expiresAt: Date.now() + UID_TTL_MS });
  return uid;
}

function parseJsonArg(raw: unknown, name: string, fallback: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new OdooError(`Campo "${name}" deve essere JSON valido: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const odooNode: NodeModule = {
  def: {
    id: 'italia_odoo',
    type: 'action',
    label: 'Odoo ERP',
    icon: 'building-2',
    color: '#714b67', // Odoo brand purple
    description: 'CRUD universale su qualsiasi modello Odoo (res.partner, sale.order, account.move, ...) + esecuzione metodi custom del modulo proprietario. JSON-RPC su /jsonrpc (Odoo 12+). Domain syntax polish notation. Authenticate cached 30min per connection. UI con progressive disclosure: vedi solo i campi che servono per l\'action scelta.',
    configFields: [
      // ── Connection (sempre visibili) ────────────────────────────────
      {
        key: 'url',
        label: 'URL Odoo',
        type: 'text',
        required: true,
        placeholder: 'https://erp.mio-cliente.com',
        help: 'Base URL Odoo SENZA trailing slash. JSON-RPC chiamato su {url}/jsonrpc. Self-hosted o Odoo.sh entrambi supportati.',
        pattern: '^https?://[^/]+$',
      },
      {
        key: 'database',
        label: 'Nome database',
        type: 'text',
        required: true,
        placeholder: 'production',
        help: 'Nome del database Odoo (visibile in Impostazioni → Tecnico → Database, oppure nel URL al login).',
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: true,
        placeholder: 'admin@cliente.com',
        help: 'Login Odoo (di solito email dell\'utente). Crea un utente dedicato "integration_bot" con permessi minimi.',
      },
      {
        key: 'apiKey',
        label: 'API key (o password)',
        type: 'secret',
        required: true,
        help: 'Odoo 14+: API key da Preferences → Account Security → Developer API Keys (scope ridotto, revocabile). Odoo <14: password utente.',
      },

      // ── Action selector ─────────────────────────────────────────────
      {
        key: 'action',
        label: 'Azione',
        type: 'select',
        required: true,
        options: [
          'search_read',
          'search',
          'read',
          'create',
          'write',
          'unlink',
          'execute_method',
          'name_search',
          'fields_get',
          'check_connection',
        ],
        defaultValue: 'search_read',
        help: 'search_read = query con campi (PIÙ USATO). search = solo IDs. read = read by IDs. create = INSERT. write = UPDATE. unlink = DELETE. execute_method = metodo Python custom su modello. name_search = autocomplete-style search (per UI). fields_get = schema introspection (discovery). check_connection = test credentials.',
      },

      // ── Model (richiesto da TUTTE le action eccetto check_connection) ──
      {
        key: 'model',
        label: 'Modello Odoo',
        type: 'expression',
        required: false,
        placeholder: 'res.partner',
        help: 'Es: res.partner, sale.order, account.move, product.product, oppure <modulo_custom>.<model> per modello del modulo proprietario. Vai in Impostazioni → Tecnico → Modelli per la lista completa. Non richiesto per check_connection.',
        showIf: { field: 'action', in: ['search_read', 'search', 'read', 'create', 'write', 'unlink', 'execute_method', 'name_search', 'fields_get'] },
      },

      // ── Domain (search_read, search, name_search) ────────────────────
      {
        key: 'domain',
        label: 'Domain (filtro records)',
        type: 'expression',
        required: false,
        placeholder: '[["is_company","=",true],["country_id.code","=","IT"]]',
        help: 'Filtro polish notation. AND implicito, OR esplicito con "|" prefix, NOT con "!" prefix. Operators: =, !=, >, >=, <, <=, like, ilike, in, not in, child_of, =like. Esempi: [["state","=","draft"]] · [["name","ilike","%mario%"]] · ["|",["a","=",1],["b","=",2]] · [["partner_id.country_id.code","=","IT"]] (dot-traversal).',
        showIf: { field: 'action', in: ['search_read', 'search', 'name_search'] },
      },

      // ── Fields (search_read, read, fields_get) ────────────────────
      {
        key: 'fields',
        label: 'Fields (campi da leggere)',
        type: 'expression',
        required: false,
        placeholder: '["id","name","vat","email","country_id"]',
        help: 'Array JSON di field names. Vuoto = tutti i campi (SCONSIGLIATO, payload pesante). Relazioni many2one ritornano [id, "display_name"]. one2many/many2many ritornano [id1, id2, ...]. Usa dot-traversal NEL domain (non nei fields).',
        showIf: { field: 'action', in: ['search_read', 'read', 'fields_get'] },
      },

      // ── Values (create, write) ────────────────────────────────────
      {
        key: 'values',
        label: 'Values (campi da scrivere)',
        type: 'expression',
        required: false,
        placeholder: '{"name":"Cliente Test","email":"x@y.it","is_company":true,"country_id":110}',
        help: 'Object JSON field→value. Per many2one passa l\'ID intero (es. country_id: 110). Per one2many/many2many usa il formato special Odoo: [[0,0,{...}]] crea child, [[1,id,{...}]] aggiorna, [[2,id]] elimina, [[3,id]] dissocia (no delete), [[4,id]] associa, [[6,0,[id1,id2]]] replace all.',
        showIf: { field: 'action', in: ['create', 'write'] },
      },

      // ── IDs (read, write, unlink, execute_method) ───────────────────
      {
        key: 'ids',
        label: 'IDs (record target)',
        type: 'expression',
        required: false,
        placeholder: '[42, 43, 44]',
        help: 'Array JSON di interi. Per write/unlink: i records modificati/cancellati. Per execute_method: i records su cui il metodo opera (convenzione Odoo). Singolo ID: [42] (sempre array).',
        showIf: { field: 'action', in: ['read', 'write', 'unlink', 'execute_method'] },
      },

      // ── Method + args + kwargs (execute_method) ───────────────────
      {
        key: 'method',
        label: 'Metodo Python',
        type: 'expression',
        required: false,
        placeholder: 'action_confirm',
        help: 'Nome del metodo da invocare sul modello. Standard Odoo: action_confirm/action_cancel/action_done su sale.order, post/action_post su account.move. Custom: nome del metodo del modulo proprietario del cliente.',
        showIf: { field: 'action', equals: 'execute_method' },
      },
      {
        key: 'args',
        label: 'Args (positional)',
        type: 'expression',
        required: false,
        placeholder: '[[42]]',
        help: 'Array positional di argomenti del metodo Python. Convenzione Odoo: il PRIMO arg è SEMPRE l\'array di IDs (es. [[42]] = metodo applicato a record id 42). Per metodi class-level (no IDs): []. Se vuoto, viene auto-popolato con [ids] dal campo IDs sopra.',
        showIf: { field: 'action', equals: 'execute_method' },
      },
      {
        key: 'kwargs',
        label: 'Kwargs (keyword args + context)',
        type: 'expression',
        required: false,
        placeholder: '{"context":{"lang":"it_IT","tz":"Europe/Rome","no_send_mail":true}}',
        help: 'Object JSON di keyword arguments. Spesso usato per context (lang/tz/no_send_mail/active_test/force_company_id). Per ignorare email automatic: {"context":{"no_send_mail":true}}.',
        showIf: { field: 'action', equals: 'execute_method' },
      },

      // ── Pagination (search_read, search) ────────────────────────────
      {
        key: 'limit',
        label: 'Limit (max records)',
        type: 'number',
        required: false,
        defaultValue: '100',
        help: 'Max records ritornati. Per export grandi (>100k): usa limit=500 + loop su offset. Default 100 per evitare payload accidentali da 100MB.',
        showIf: { field: 'action', in: ['search_read', 'search', 'name_search'] },
      },
      {
        key: 'offset',
        label: 'Offset (pagination)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help: 'Offset per pagination. Loop deterministico: offset=0,500,1000... finché result.length < limit (= ultima pagina).',
        showIf: { field: 'action', in: ['search_read', 'search'] },
      },
      {
        key: 'order',
        label: 'Order (ORDER BY)',
        type: 'expression',
        required: false,
        placeholder: 'create_date desc, id desc',
        help: 'Sintassi SQL-like. Esempi: "create_date desc" · "name asc, id desc" · "priority asc, write_date desc". Per pagination stabile usa SEMPRE un tiebreak su id.',
        showIf: { field: 'action', in: ['search_read', 'search'] },
      },

      // ── name_search ────────────────────────────────────────────────
      {
        key: 'name',
        label: 'Query name_search',
        type: 'expression',
        required: false,
        placeholder: 'Mario',
        help: 'Stringa matched contro display_name. Usata dagli autocomplete Odoo. Operator default: "ilike" (case-insensitive substring). Ottimo per integrazioni "type-ahead" (es. search Cliente da nome parziale).',
        showIf: { field: 'action', equals: 'name_search' },
      },
    ],
    outputs: ['result', 'count'],
    vendor: 'odoo',
    version: '1.0.0',
  },

  executor: async (config, _input, _context) => {
    const start = Date.now();
    const cfg = config as Record<string, string | undefined>;
    const conn: OdooConnection = {
      url: cfg.url ?? '',
      db: cfg.database ?? '',
      username: cfg.username ?? '',
      apiKey: cfg.apiKey ?? '',
    };
    if (!conn.url || !conn.db || !conn.username || !conn.apiKey) {
      throw new Error('italia_odoo: url + database + username + apiKey sono obbligatori.');
    }

    const action = cfg.action ?? 'search_read';

    // check_connection: pre-flight per UI test button (no model required).
    if (action === 'check_connection') {
      const uid = await getAuthenticatedUid(conn);
      return { output: { ok: true, uid }, durationMs: Date.now() - start };
    }

    const model = cfg.model ?? '';
    if (!model) throw new Error('italia_odoo: model obbligatorio per ogni action eccetto check_connection.');

    const uid = await getAuthenticatedUid(conn);

    const domain = parseJsonArg(cfg.domain, 'domain', []) as unknown[];
    const fields = parseJsonArg(cfg.fields, 'fields', []) as string[];
    const ids = parseJsonArg(cfg.ids, 'ids', []) as number[];
    const values = parseJsonArg(cfg.values, 'values', {}) as Record<string, unknown>;
    const limit = cfg.limit ? parseInt(cfg.limit, 10) : 100;
    const offset = cfg.offset ? parseInt(cfg.offset, 10) : 0;
    const order = cfg.order ?? undefined;

    let result: unknown;
    let count = 0;

    switch (action) {
      case 'search_read': {
        const kwargs: Record<string, unknown> = { limit, offset };
        if (fields.length > 0) kwargs.fields = fields;
        if (order) kwargs.order = order;
        result = await executeKw(conn, uid, model, 'search_read', [domain], kwargs);
        count = Array.isArray(result) ? result.length : 0;
        break;
      }
      case 'search': {
        const kwargs: Record<string, unknown> = { limit, offset };
        if (order) kwargs.order = order;
        result = await executeKw(conn, uid, model, 'search', [domain], kwargs);
        count = Array.isArray(result) ? result.length : 0;
        break;
      }
      case 'read': {
        if (ids.length === 0) throw new Error('italia_odoo read: ids array obbligatorio (es. [42]).');
        const kwargs: Record<string, unknown> = {};
        if (fields.length > 0) kwargs.fields = fields;
        result = await executeKw(conn, uid, model, 'read', [ids], kwargs);
        count = Array.isArray(result) ? result.length : 0;
        break;
      }
      case 'create': {
        if (!values || Object.keys(values).length === 0) throw new Error('italia_odoo create: values object obbligatorio.');
        result = await executeKw(conn, uid, model, 'create', [values]);
        count = 1;
        break;
      }
      case 'write': {
        if (ids.length === 0) throw new Error('italia_odoo write: ids array obbligatorio.');
        if (!values || Object.keys(values).length === 0) throw new Error('italia_odoo write: values object obbligatorio.');
        result = await executeKw(conn, uid, model, 'write', [ids, values]);
        count = ids.length;
        break;
      }
      case 'unlink': {
        if (ids.length === 0) throw new Error('italia_odoo unlink: ids array obbligatorio.');
        result = await executeKw(conn, uid, model, 'unlink', [ids]);
        count = ids.length;
        break;
      }
      case 'name_search': {
        const name = cfg.name ?? '';
        const kwargs: Record<string, unknown> = { limit };
        if (domain.length > 0) kwargs.args = domain;
        result = await executeKw(conn, uid, model, 'name_search', [name], kwargs);
        count = Array.isArray(result) ? result.length : 0;
        break;
      }
      case 'fields_get': {
        // Schema introspection — utile per discovery + AI scaffold del cliente.
        const kwargs: Record<string, unknown> = {};
        if (fields.length > 0) kwargs.allfields = fields;
        result = await executeKw(conn, uid, model, 'fields_get', [], kwargs);
        count = typeof result === 'object' && result !== null ? Object.keys(result).length : 0;
        break;
      }
      case 'execute_method': {
        const method = cfg.method ?? '';
        if (!method) throw new Error('italia_odoo execute_method: method obbligatorio.');
        const args = parseJsonArg(cfg.args, 'args', ids.length > 0 ? [ids] : []) as unknown[];
        const kwargs = parseJsonArg(cfg.kwargs, 'kwargs', {}) as Record<string, unknown>;
        result = await executeKw(conn, uid, model, method, args, kwargs);
        count = Array.isArray(result) ? result.length : 1;
        break;
      }
      default:
        throw new Error(`italia_odoo: action "${action}" sconosciuta.`);
    }

    return {
      output: { result, count, model, action },
      durationMs: Date.now() - start,
    };
  },
};
