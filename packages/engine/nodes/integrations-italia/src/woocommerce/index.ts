/**
 * WooCommerce connector — REST API v3, Basic Auth (consumer_key/secret).
 *
 * WooCommerce è il plugin e-commerce #1 per WordPress (~30% market share
 * e-commerce mondiale). REST API v3 stable da WC 3.5+, mount su
 * /wp-json/wc/v3/* (al posto di /wp-json/wp/v2/).
 *
 * Stack 2026:
 *   • Auth: Basic Auth con (consumer_key, consumer_secret) su HTTPS (spec WC).
 *     Fallback HTTP-only (raro, sconsigliato): le credenziali come query param
 *     consumer_key/consumer_secret. NB: NON è OAuth1 (firma) — è query-param auth.
 *   • Endpoints completi: products, product_variations, orders, customers,
 *     coupons, refunds, taxes, shipping_zones, payment_gateways, reports,
 *     system_status, webhooks, settings.
 *   • Batch endpoint: POST /wc/v3/<resource>/batch con { create, update, delete }
 *     → fino a 100 ops in 1 request (atomic per default WC).
 *   • Filtering: 30+ query params (status, customer, date_created, search,
 *     meta_key/meta_value per ACF/JetEngine, taxonomy attribute filter).
 *   • Pagination: ?per_page=100 (max), ?page=N, headers X-WP-TotalPages.
 *
 * 30% market share. Customer base massiccio. NO REASON not to have it.
 */

import type { NodeModule } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
import {
  safeFetchWithRedirects,
  readJsonCapped,
  readTextTruncated,
} from '@medea/engine-safe-fetch';

interface WcConnection {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

/**
 * Parse di un campo JSON dell'utente (body/batch) con errore PULITO: `JSON.parse`
 * grezzo lancerebbe un `SyntaxError` opaco ("Unexpected token …") che confonde
 * l'operatore. Qui il messaggio dice QUALE campo è malformato.
 */
function parseJsonField(raw: string | undefined, field: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`italia_woocommerce: il campo "${field}" non è JSON valido.`);
  }
}

async function wcFetch<T = unknown>(
  conn: WcConnection,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ data: T; totalPages: number; total: number }> {
  const url = new URL(`${conn.baseUrl.replace(/\/+$/, '')}/wp-json/wc/v3${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  // HTTPS-only: Basic Auth con consumer_key + consumer_secret
  // HTTP fallback: query params (sconsigliato — credentials in access log)
  const isHttps = url.protocol === 'https:';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (isHttps) {
    headers.Authorization = `Basic ${Buffer.from(`${conn.consumerKey}:${conn.consumerSecret}`, 'utf8').toString('base64')}`;
  } else {
    // Fallback HTTP-only: query params
    url.searchParams.set('consumer_key', conn.consumerKey);
    url.searchParams.set('consumer_secret', conn.consumerSecret);
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  // Gateway: per-host circuit breaker (come fic/register-it) + safeFetch (timeout
  // default 30s + SSRF). baseUrl è user-provided → un host del cliente impallato
  // non deve drogare il pool degli altri workflow (breaker keyed per-host).
  const res = await executeWithHostBreaker(url.toString(), () =>
    safeFetchWithRedirects(url.toString(), init as never),
  );
  if (!res.ok) {
    // anti-OOM: estratto d'errore troncato in streaming (un endpoint rotto può
    // rispondere con HTML enorme), non res.text() integrale.
    const text = (await readTextTruncated(res, 8192)).text;
    let err: { code?: string; message?: string } = {};
    try {
      err = JSON.parse(text) as typeof err;
    } catch {
      /* keep raw */
    }
    throw new Error(
      `WooCommerce ${err.code ?? res.status.toString()}: ${err.message ?? text.slice(0, 200)}`,
    );
  }
  const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1', 10);
  const total = parseInt(res.headers.get('x-wp-total') ?? '0', 10);
  // anti-OOM: una list-API WooCommerce può tornare decine di migliaia di record.
  const data = await readJsonCapped<T>(res);
  return { data, totalPages, total };
}

export const woocommerceNode: NodeModule = {
  def: {
    id: 'italia_woocommerce',
    type: 'action',
    label: 'WooCommerce',
    icon: 'shopping-cart',
    color: '#7f54b3',
    description:
      'CRUD universale su WooCommerce REST API v3. Products, orders, customers, coupons, refunds, taxes, shipping zones, batch endpoint (100 ops/req). 30% e-commerce market share — cliente con shop online ne ha probabilmente uno. Auth: consumer_key + consumer_secret da WooCommerce → Settings → Advanced → REST API.',
    configFields: [
      {
        key: 'baseUrl',
        label: 'URL WooCommerce',
        type: 'text',
        required: true,
        placeholder: 'https://mio-shop.it',
        help: 'URL base WordPress dove gira WooCommerce. REST API: {baseUrl}/wp-json/wc/v3/*. HTTPS obbligatorio per Basic Auth (raccomandato).',
        pattern: '^https?://[^/]+$',
      },
      {
        key: 'consumerKey',
        label: 'Consumer Key',
        type: 'secret',
        required: true,
        placeholder: 'ck_...',
        help: 'Genera da WooCommerce → Settings → Advanced → REST API → Add key. Scope: Read/Write per CRUD completo, Read per query-only.',
      },
      {
        key: 'consumerSecret',
        label: 'Consumer Secret',
        type: 'secret',
        required: true,
        placeholder: 'cs_...',
        help: 'Compagno della consumer_key. Conserva al momento della generazione (NON re-visualizzabile dopo).',
      },

      {
        key: 'action',
        label: 'Azione',
        type: 'select',
        required: true,
        options: ['list', 'get', 'create', 'update', 'delete', 'batch'],
        defaultValue: 'list',
        help: 'list = GET many. get = GET one by ID. create = POST. update = PUT. delete = DELETE (?force=true per hard delete). batch = POST .../batch (fino a 100 ops in 1 round-trip).',
      },
      {
        key: 'resource',
        label: 'Resource',
        type: 'select',
        required: true,
        options: [
          'products',
          'products/variations',
          'products/categories',
          'products/attributes',
          'products/tags',
          'orders',
          'orders/notes',
          'orders/refunds',
          'customers',
          'coupons',
          'reports',
          'taxes',
          'shipping/zones',
          'payment_gateways',
          'webhooks',
          'settings',
        ],
        defaultValue: 'products',
        help: 'Endpoint WC. Per nested (es. variazioni prodotto): "products/variations" con parentId nel customPath.',
      },
      {
        key: 'parentId',
        label: 'Parent ID',
        type: 'expression',
        required: false,
        placeholder: '42',
        help: 'Per nested resources (variations under product, notes/refunds under order). Es: resource="products/variations", parentId=42 → /products/42/variations.',
        showIf: {
          field: 'resource',
          in: ['products/variations', 'orders/notes', 'orders/refunds'],
        },
      },

      {
        key: 'id',
        label: 'ID',
        type: 'expression',
        required: false,
        help: 'ID risorsa (intero). Obbligatorio per get/update/delete.',
        showIf: { field: 'action', in: ['get', 'update', 'delete'] },
      },

      // List filters (per_page, search, status, ecc.)
      {
        key: 'perPage',
        label: 'Per page',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Default 10, max 100 (WC cap).',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'page',
        label: 'Page',
        type: 'number',
        required: false,
        defaultValue: '1',
        help: 'Pagination 1-indexed. X-WP-TotalPages header per loop completo.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'search',
        label: 'Search',
        type: 'expression',
        required: false,
        placeholder: 'nome prodotto',
        help: 'Full-text WC server-side.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'status',
        label: 'Status filter',
        type: 'expression',
        required: false,
        placeholder: 'pending,processing,completed',
        help: 'Per orders: pending/processing/on-hold/completed/cancelled/refunded/failed/trash. Per products: draft/pending/private/publish. CSV multi-status.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'after',
        label: 'Data dopo (ISO 8601)',
        type: 'expression',
        required: false,
        placeholder: '2026-01-01T00:00:00',
        help: 'Filtra date_created >= valore. Ottimo per sync incrementale.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'before',
        label: 'Data prima (ISO 8601)',
        type: 'expression',
        required: false,
        placeholder: '2026-12-31T23:59:59',
        help: 'Filtra date_created <= valore.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'customer',
        label: 'Customer ID filter',
        type: 'expression',
        required: false,
        help: 'Solo per orders. Filtra ordini di un cliente specifico.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'orderby',
        label: 'Order by',
        type: 'select',
        required: false,
        options: ['date', 'id', 'include', 'title', 'slug', 'price', 'popularity', 'rating'],
        defaultValue: 'date',
        help: 'Solo per list. price/popularity/rating solo su products.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'orderDir',
        label: 'Order direction',
        type: 'select',
        required: false,
        options: ['asc', 'desc'],
        defaultValue: 'desc',
        showIf: { field: 'action', equals: 'list' },
      },

      // Create/Update body
      {
        key: 'data',
        label: 'Body JSON',
        type: 'expression',
        required: false,
        placeholder:
          '{"name":"Maglietta XL","type":"simple","regular_price":"29.90","stock_quantity":10,"manage_stock":true}',
        help: 'Per create/update. Schema completo: https://woocommerce.github.io/woocommerce-rest-api-docs/. Per products: name, type, regular_price, sale_price, stock_quantity, manage_stock, categories[], images[], attributes[], variations[].',
        showIf: { field: 'action', in: ['create', 'update'] },
      },

      // Batch
      {
        key: 'batchData',
        label: 'Batch JSON',
        type: 'expression',
        required: false,
        placeholder: '{"create":[{...},{...}],"update":[{"id":42,...}],"delete":[1,2,3]}',
        help: 'Per action=batch. Object con chiavi create/update/delete. Max 100 ops totali per request (WC default). create[] = array di body POST. update[] = array di body PUT con id incluso. delete[] = array di IDs.',
        showIf: { field: 'action', equals: 'batch' },
      },

      // Delete force
      {
        key: 'force',
        label: 'Force delete (hard)',
        type: 'select',
        required: false,
        options: ['false', 'true'],
        defaultValue: 'false',
        help: 'true = bypass trash (irreversibile). Default WC: orders e products vanno in trash.',
        showIf: { field: 'action', equals: 'delete' },
      },
    ],
    outputs: ['result', 'totalPages', 'total'],
    outputContract: {
      notes: 'La risposta sta in `result`, con la forma che le da` WooCommerce per quella risorsa. Elencando, `totalPages` e `total` dicono che c\'e` dell\'altro: senza chiedere le pagine successive si prende solo la prima.',
      fields: [
        { name: 'result', type: 'object|array', desc: 'La risposta di WooCommerce, con la forma che ha per quella risorsa.' },
        { name: 'totalPages', type: 'number', desc: 'Quante pagine di risultati esistono. Solo elencando.' },
        { name: 'total', type: 'number', desc: 'Quanti elementi in tutto. Solo elencando.' },
        { name: 'action', type: 'string', desc: 'L\'operazione eseguita.' },
        { name: 'resource', type: 'string', desc: 'La risorsa su cui ha operato: ordini, prodotti, clienti.' },
      ],
    },
    vendor: 'woocommerce',
    version: '1.0.0',
  },
  executor: async (config, _input, _context) => {
    const start = Date.now();
    const cfg = config as Record<string, string | undefined>;
    const conn: WcConnection = {
      baseUrl: cfg.baseUrl ?? '',
      consumerKey: cfg.consumerKey ?? '',
      consumerSecret: cfg.consumerSecret ?? '',
    };
    if (!conn.baseUrl || !conn.consumerKey || !conn.consumerSecret) {
      throw new Error('italia_woocommerce: baseUrl + consumerKey + consumerSecret obbligatori.');
    }
    const action = cfg.action ?? 'list';
    const resource = cfg.resource ?? 'products';
    const parentId = cfg.parentId;

    // Path nesting: "products/variations" + parentId 42 → /products/42/variations
    let basePath: string;
    if (
      (resource === 'products/variations' ||
        resource === 'orders/notes' ||
        resource === 'orders/refunds') &&
      parentId
    ) {
      const [parent, child] = resource.split('/');
      basePath = `/${parent}/${parentId}/${child}`;
    } else {
      basePath = `/${resource}`;
    }

    switch (action) {
      case 'list': {
        const query: Record<string, string> = {
          per_page: cfg.perPage ?? '10',
          page: cfg.page ?? '1',
        };
        if (cfg.search) query.search = cfg.search;
        if (cfg.status) query.status = cfg.status;
        if (cfg.after) query.after = cfg.after;
        if (cfg.before) query.before = cfg.before;
        if (cfg.customer) query.customer = cfg.customer;
        if (cfg.orderby) query.orderby = cfg.orderby;
        if (cfg.orderDir) query.order = cfg.orderDir;
        const { data, totalPages, total } = await wcFetch(conn, 'GET', basePath, undefined, query);
        return {
          output: { result: data, totalPages, total, action, resource },
          durationMs: Date.now() - start,
        };
      }
      case 'get': {
        const id = cfg.id;
        if (!id) throw new Error('italia_woocommerce get: id obbligatorio.');
        const { data } = await wcFetch(conn, 'GET', `${basePath}/${id}`);
        return { output: { result: data, action, resource }, durationMs: Date.now() - start };
      }
      case 'create': {
        const body = parseJsonField(cfg.data, 'data');
        const { data } = await wcFetch(conn, 'POST', basePath, body);
        return { output: { result: data, action, resource }, durationMs: Date.now() - start };
      }
      case 'update': {
        const id = cfg.id;
        if (!id) throw new Error('italia_woocommerce update: id obbligatorio.');
        const body = parseJsonField(cfg.data, 'data');
        const { data } = await wcFetch(conn, 'PUT', `${basePath}/${id}`, body);
        return { output: { result: data, action, resource }, durationMs: Date.now() - start };
      }
      case 'delete': {
        const id = cfg.id;
        if (!id) throw new Error('italia_woocommerce delete: id obbligatorio.');
        const query: Record<string, string> = {};
        if (cfg.force === 'true') query.force = 'true';
        const { data } = await wcFetch(conn, 'DELETE', `${basePath}/${id}`, undefined, query);
        return { output: { result: data, action, resource }, durationMs: Date.now() - start };
      }
      case 'batch': {
        // POST {resource}/batch — atomic fino a 100 ops
        const body = parseJsonField(cfg.batchData, 'batchData');
        const { data } = await wcFetch(conn, 'POST', `${basePath}/batch`, body);
        return { output: { result: data, action, resource }, durationMs: Date.now() - start };
      }
      default:
        throw new Error(`italia_woocommerce: action "${action}" sconosciuta.`);
    }
  },
};
