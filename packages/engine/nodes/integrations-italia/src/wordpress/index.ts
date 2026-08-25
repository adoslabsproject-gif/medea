/**
 * WordPress connector — REST API v2 + Application Passwords.
 *
 * WordPress 4.4+ ha la REST API integrata su /wp-json/wp/v2/*. WordPress 5.6+
 * supporta Application Passwords (Basic Auth con password app-specifica,
 * revocabile per app, generabile da Users → Profile → Application Passwords).
 *
 * Stack 2026:
 *   • Basic Auth con Application Password (NO password utente, revocabile)
 *   • Endpoints standard: posts, pages, media, users, categories, tags, comments
 *   • Status DRAFT/PUBLISH/PRIVATE preservato
 *   • Embed query per espandere relations (author, featured_media, ...)
 *   • Pagination via X-WP-TotalPages header
 *
 * 43% del web gira WordPress. Customer base ovunque (small business + media
 * + e-commerce). NO REASON per non averlo.
 */

import type { NodeModule } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
import {
  safeFetchWithRedirects,
  readJsonCapped,
  readTextTruncated,
} from '@medea/engine-safe-fetch';

interface WpConnection {
  baseUrl: string;
  username: string;
  appPassword: string;
}

/**
 * Parse di un campo JSON dell'utente (body create/update) con errore PULITO:
 * `JSON.parse` grezzo lancerebbe un `SyntaxError` opaco. Qui il messaggio dice
 * QUALE campo è malformato.
 */
function parseJsonField(raw: string | undefined, field: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`italia_wordpress: il campo "${field}" non è JSON valido.`);
  }
}

interface WpError {
  code: string;
  message: string;
  data?: { status?: number };
}

interface WpResult<T> {
  data: T;
  totalPages: number;
}

async function wpFetch<T = unknown>(
  conn: WpConnection,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<WpResult<T>> {
  const url = new URL(`${conn.baseUrl.replace(/\/+$/, '')}/wp-json/wp/v2${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const authHeader = `Basic ${Buffer.from(`${conn.username}:${conn.appPassword}`, 'utf8').toString('base64')}`;
  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  // Gateway: per-host circuit breaker (come fic/register-it) + safeFetch (timeout
  // default 30s + SSRF). baseUrl è user-provided → un host del cliente impallato
  // non deve drogare il pool (breaker keyed per-host).
  const res = await executeWithHostBreaker(url.toString(), () =>
    safeFetchWithRedirects(url.toString(), init as never),
  );
  if (!res.ok) {
    let err: WpError;
    try {
      err = await readJsonCapped<WpError>(res);
    } catch {
      err = { code: 'http_error', message: `HTTP ${res.status.toString()}` };
    }
    throw new Error(`WordPress ${err.code}: ${err.message} (HTTP ${res.status.toString()})`);
  }
  // X-WP-TotalPages: numero pagine totali (per il loop di pagination completo).
  const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1', 10);
  const data = await readJsonCapped<T>(res);
  return { data, totalPages: Number.isFinite(totalPages) ? totalPages : 1 };
}

export const wordpressNode: NodeModule = {
  def: {
    id: 'italia_wordpress',
    type: 'action',
    label: 'WordPress',
    icon: 'globe',
    color: '#21759b',
    description:
      'CRUD universale su WordPress REST API v2. Posts, pages, media, users, categories, tags, comments. Auth via Application Password (Users → Profile → Application Passwords, WordPress 5.6+). 43% del web gira WP — ideale per cliente con sito vetrina, blog, magazine, landing pages.',
    configFields: [
      {
        key: 'baseUrl',
        label: 'URL WordPress',
        type: 'text',
        required: true,
        placeholder: 'https://mio-sito.it',
        help: 'URL base WordPress (senza trailing slash). REST API si trova su {baseUrl}/wp-json/wp/v2/*.',
        pattern: '^https?://[^/]+$',
      },
      {
        key: 'username',
        label: 'Username WP',
        type: 'text',
        required: true,
        placeholder: 'admin',
        help: "Login WordPress dell'utente proprietario della Application Password.",
      },
      {
        key: 'appPassword',
        label: 'Application Password',
        type: 'secret',
        required: true,
        help: 'Genera da Users → Profile → Application Passwords. NOT la password utente, NOT API key plugin (jwt-auth). Formato: 4 blocchi di 4 caratteri separati da spazi (es: "abcd efgh ijkl mnop").',
      },

      {
        key: 'action',
        label: 'Azione',
        type: 'select',
        required: true,
        options: ['list', 'get', 'create', 'update', 'delete', 'upload_media'],
        defaultValue: 'list',
        help: 'list = GET many. get = GET one by ID. create = POST. update = POST (PATCH idempotent). delete = DELETE (move to trash, ?force=true per hard delete). upload_media = POST multipart.',
      },
      {
        key: 'resource',
        label: 'Resource',
        type: 'select',
        required: true,
        options: ['posts', 'pages', 'media', 'users', 'categories', 'tags', 'comments', 'custom'],
        defaultValue: 'posts',
        help: 'Endpoint WP. "custom" = path arbitrary (es. custom post type / plugin REST). Per CPT: usa "custom" con customPath = "/mio_cpt".',
      },
      {
        key: 'customPath',
        label: 'Custom path',
        type: 'expression',
        required: false,
        placeholder: '/jet-engine/v1/products',
        help: 'Solo se resource=custom. Path REST relativo a /wp-json (es. "/jet-engine/v1/products" → {baseUrl}/wp-json/jet-engine/v1/products). Sostituisce sia il prefix /wp/v2 che il resource standard.',
        showIf: { field: 'resource', equals: 'custom' },
      },

      // list/get common
      {
        key: 'id',
        label: 'ID',
        type: 'expression',
        required: false,
        help: 'ID risorsa (intero) per get/update/delete.',
        showIf: { field: 'action', in: ['get', 'update', 'delete'] },
      },

      // list pagination
      {
        key: 'perPage',
        label: 'Per page',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Max 100 (WP cap). Default 10 (WP default).',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'page',
        label: 'Page',
        type: 'number',
        required: false,
        defaultValue: '1',
        help: 'Pagination 1-indexed.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'search',
        label: 'Search',
        type: 'expression',
        required: false,
        placeholder: 'parola chiave',
        help: 'Full-text search server-side (matching title + content).',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'status',
        label: 'Status filter',
        type: 'select',
        required: false,
        options: ['publish', 'draft', 'pending', 'private', 'future', 'trash', 'any'],
        help: 'Solo per posts/pages. "any" include trash. Default: publish.',
        showIf: { field: 'action', equals: 'list' },
      },
      {
        key: 'embed',
        label: 'Embed relations',
        type: 'select',
        required: false,
        options: ['false', 'true'],
        defaultValue: 'false',
        help: '?_embed=true espande author/featured_media/replies/term inline (più payload ma meno round-trip).',
        showIf: { field: 'action', in: ['list', 'get'] },
      },

      // create/update body
      {
        key: 'data',
        label: 'Body JSON',
        type: 'expression',
        required: false,
        placeholder:
          '{"title":"Mio articolo","content":"<p>HTML</p>","status":"draft","categories":[5]}',
        help: 'Per create/update. Campi standard WP: title, content, excerpt, status, categories[], tags[], featured_media, slug, meta {}. Status "draft" raccomandato per primo INSERT (rivedi prima di publish).',
        showIf: { field: 'action', in: ['create', 'update'] },
      },

      // upload_media
      {
        key: 'fileName',
        label: 'File name',
        type: 'expression',
        required: false,
        placeholder: 'foto.jpg',
        help: 'Nome file media (con estensione). MIME inferito da estensione.',
        showIf: { field: 'action', equals: 'upload_media' },
      },
      {
        key: 'fileContentBase64',
        label: 'File content (base64)',
        type: 'expression',
        required: false,
        help: 'Contenuto binario base64. Per file >5MB usa Drive upload + URL reference.',
        showIf: { field: 'action', equals: 'upload_media' },
      },

      // delete force
      {
        key: 'force',
        label: 'Force delete (hard)',
        type: 'select',
        required: false,
        options: ['false', 'true'],
        defaultValue: 'false',
        help: 'true = hard delete bypass trash (irreversibile).',
        showIf: { field: 'action', equals: 'delete' },
      },
    ],
    outputs: ['result', 'totalPages'],
    outputContract: {
      notes: 'La risposta sta in `result`, con la forma che le da` WordPress. Elencando, `totalPages` dice che c\'e` dell\'altro oltre la prima pagina.',
      fields: [
        { name: 'result', type: 'object|array', desc: 'La risposta di WordPress, con la forma che ha per quella risorsa.' },
        { name: 'totalPages', type: 'number', desc: 'Quante pagine di risultati esistono. Solo elencando.' },
        { name: 'action', type: 'string', desc: 'L\'operazione eseguita.' },
        { name: 'resource', type: 'string', desc: 'La risorsa su cui ha operato: articoli, pagine, media.' },
      ],
    },
    vendor: 'wordpress',
    version: '1.1.0',
  },
  executor: async (config, _input, _context) => {
    const start = Date.now();
    const cfg = config as Record<string, string | undefined>;
    const conn: WpConnection = {
      baseUrl: cfg.baseUrl ?? '',
      username: cfg.username ?? '',
      appPassword: cfg.appPassword ?? '',
    };
    if (!conn.baseUrl || !conn.username || !conn.appPassword) {
      throw new Error('italia_wordpress: baseUrl + username + appPassword obbligatori.');
    }
    const action = cfg.action ?? 'list';
    const resource = cfg.resource ?? 'posts';
    const customPath = cfg.customPath;

    // Path resolution: resource=custom → customPath override, altrimenti /<resource>
    let basePath: string;
    if (resource === 'custom') {
      if (!customPath)
        throw new Error('italia_wordpress: customPath richiesto quando resource=custom.');
      // Special: customPath sostituisce /wp/v2 — fa fetch su {baseUrl}/wp-json + customPath
      basePath = ''; // gestito sotto
    } else {
      basePath = `/${resource}`;
    }

    const wpReq = async <T>(
      method: string,
      path: string,
      body?: unknown,
      query?: Record<string, string>,
    ): Promise<WpResult<T>> => {
      if (resource === 'custom') {
        // Bypass /wp/v2: chiamo direttamente {baseUrl}/wp-json{customPath}
        const url = new URL(
          `${conn.baseUrl.replace(/\/+$/, '')}/wp-json${customPath ?? ''}${path}`,
        );
        if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        const authHeader = `Basic ${Buffer.from(`${conn.username}:${conn.appPassword}`, 'utf8').toString('base64')}`;
        const headers: Record<string, string> = {
          Authorization: authHeader,
          Accept: 'application/json',
        };
        const init: RequestInit = { method, headers };
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        const res = await executeWithHostBreaker(url.toString(), () =>
          safeFetchWithRedirects(url.toString(), init as never),
        );
        if (!res.ok) {
          const txt = (await readTextTruncated(res, 8192)).text;
          throw new Error(`WordPress custom ${res.status.toString()}: ${txt.slice(0, 200)}`);
        }
        const totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1', 10);
        const data = await readJsonCapped<T>(res);
        return { data, totalPages: Number.isFinite(totalPages) ? totalPages : 1 };
      }
      return wpFetch<T>(conn, method, basePath + path, body, query);
    };

    switch (action) {
      case 'list': {
        const query: Record<string, string> = {
          per_page: cfg.perPage ?? '10',
          page: cfg.page ?? '1',
        };
        if (cfg.search) query.search = cfg.search;
        if (cfg.status) query.status = cfg.status;
        if (cfg.embed === 'true') query._embed = 'true';
        const { data: result, totalPages } = await wpReq('GET', '', undefined, query);
        return { output: { result, totalPages, action, resource }, durationMs: Date.now() - start };
      }
      case 'get': {
        const id = cfg.id;
        if (!id) throw new Error('italia_wordpress get: id obbligatorio.');
        const query: Record<string, string> = {};
        if (cfg.embed === 'true') query._embed = 'true';
        const { data: result } = await wpReq('GET', `/${id}`, undefined, query);
        return { output: { result, action, resource }, durationMs: Date.now() - start };
      }
      case 'create': {
        const data = parseJsonField(cfg.data, 'data');
        const { data: result } = await wpReq('POST', '', data);
        return { output: { result, action, resource }, durationMs: Date.now() - start };
      }
      case 'update': {
        const id = cfg.id;
        if (!id) throw new Error('italia_wordpress update: id obbligatorio.');
        const data = parseJsonField(cfg.data, 'data');
        const { data: result } = await wpReq('POST', `/${id}`, data);
        return { output: { result, action, resource }, durationMs: Date.now() - start };
      }
      case 'delete': {
        const id = cfg.id;
        if (!id) throw new Error('italia_wordpress delete: id obbligatorio.');
        const query: Record<string, string> = {};
        if (cfg.force === 'true') query.force = 'true';
        const { data: result } = await wpReq('DELETE', `/${id}`, undefined, query);
        return { output: { result, action, resource }, durationMs: Date.now() - start };
      }
      case 'upload_media': {
        const fileName = cfg.fileName;
        const b64 = cfg.fileContentBase64;
        if (!fileName || !b64)
          throw new Error(
            'italia_wordpress upload_media: fileName + fileContentBase64 obbligatori.',
          );
        const bytes = Buffer.from(b64, 'base64');
        // Upload via Content-Disposition (WP REST raccomandato)
        const url = new URL(`${conn.baseUrl.replace(/\/+$/, '')}/wp-json/wp/v2/media`);
        const authHeader = `Basic ${Buffer.from(`${conn.username}:${conn.appPassword}`, 'utf8').toString('base64')}`;
        // MIME inferito da estensione
        const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
          pdf: 'application/pdf',
          mp4: 'video/mp4',
        };
        const mime = mimeMap[ext] ?? 'application/octet-stream';
        const res = await executeWithHostBreaker(url.toString(), () =>
          safeFetchWithRedirects(url.toString(), {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': mime,
              'Content-Disposition': `attachment; filename="${fileName}"`,
            },
            body: bytes,
          }),
        );
        if (!res.ok) {
          const txt = (await readTextTruncated(res, 8192)).text;
          throw new Error(`WordPress media upload ${res.status.toString()}: ${txt.slice(0, 200)}`);
        }
        const result = await readJsonCapped(res);
        return { output: { result, action, resource: 'media' }, durationMs: Date.now() - start };
      }
      default:
        throw new Error(`italia_wordpress: action "${action}" sconosciuta.`);
    }
  },
};
