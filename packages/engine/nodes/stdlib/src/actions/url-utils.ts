/**
 * action_url — costruzione e analisi di URL e query string, basato sull'oggetto
 * `URL`/`URLSearchParams` nativo (built-in, ZERO dipendenze, browser-safe).
 * Sostituisce le concatenazioni di stringhe fragili e i nodi Code per gli URL.
 */
import type { NodeModule, NodeExecutor } from '../types.js';

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

const urlExecutor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const op = str(config.operation, 'parse');
  const raw = str(config.url !== undefined && str(config.url) !== '' ? config.url : input);

  if (op === 'parse') {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`action_url: URL non valido "${raw}"`);
    }
    const query: Record<string, string> = {};
    u.searchParams.forEach((val, k) => {
      query[k] = val;
    });
    return {
      output: {
        protocol: u.protocol.replace(':', ''),
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        query,
        hash: u.hash.replace('#', ''),
        origin: u.origin,
        href: u.href,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  if (op === 'setQuery' || op === 'removeQuery') {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`action_url: URL non valido "${raw}"`);
    }
    let params: Record<string, unknown> = {};
    const rawParams = config.params;
    if (rawParams && typeof rawParams === 'object') params = rawParams as Record<string, unknown>;
    else if (typeof rawParams === 'string' && rawParams.trim() !== '') {
      try {
        params = JSON.parse(rawParams) as Record<string, unknown>;
      } catch {
        /* ignora */
      }
    }
    if (op === 'setQuery')
      for (const [k, val] of Object.entries(params)) u.searchParams.set(k, str(val));
    else for (const k of Object.keys(params)) u.searchParams.delete(k);
    return {
      output: { href: u.href, query: Object.fromEntries(u.searchParams) },
      durationMs: Date.now() - startedAt,
    };
  }

  if (op === 'build') {
    const base = str(config.base);
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      throw new Error(`action_url: base non valida "${base}"`);
    }
    const path = str(config.path);
    if (path) u.pathname = path.startsWith('/') ? path : `/${path}`;
    let params: Record<string, unknown> = {};
    const rawParams = config.params;
    if (rawParams && typeof rawParams === 'object') params = rawParams as Record<string, unknown>;
    else if (typeof rawParams === 'string' && rawParams.trim() !== '') {
      try {
        params = JSON.parse(rawParams) as Record<string, unknown>;
      } catch {
        /* ignora */
      }
    }
    for (const [k, val] of Object.entries(params)) u.searchParams.set(k, str(val));
    return {
      output: { href: u.href, query: Object.fromEntries(u.searchParams) },
      durationMs: Date.now() - startedAt,
    };
  }

  if (op === 'encode')
    return { output: { result: encodeURIComponent(raw) }, durationMs: Date.now() - startedAt };
  if (op === 'decode') {
    // decodeURIComponent lancia URIError su percent-encoding malformato (es. "%",
    // "%ZZ"): l'input è utente-controllato → errore CHIARO invece di eccezione grezza.
    try {
      return { output: { result: decodeURIComponent(raw) }, durationMs: Date.now() - startedAt };
    } catch {
      throw new Error(
        `action_url: impossibile decodificare "${raw}" (sequenza percent-encoding non valida)`,
      );
    }
  }

  throw new Error(`action_url: operazione sconosciuta "${op}"`);
};

export const urlNode: NodeModule = {
  def: {
    id: 'action_url',
    type: 'action',
    label: 'URL',
    icon: 'link',
    color: '#2563eb',
    description:
      "Nodo per costruire, analizzare e modificare URL e query string in modo SICURO, basato sull'oggetto URL " +
      "nativo (zero dipendenze) invece delle fragili concatenazioni di stringhe che rompono l'encoding. Sei " +
      'operazioni da dropdown: ' +
      '(1) PARSE — scompone un URL in tutte le sue parti (protocollo, host, porta, percorso, query come oggetto ' +
      'chiave/valore, hash, origin) per ispezionare callback, webhook, redirect; ' +
      "(2) BUILD — compone un URL da una base, un percorso e parametri di query, con l'encoding automatico e " +
      'corretto di ogni valore (spazi, accenti, simboli) — niente più "&" e "%20" sbagliati a mano; ' +
      '(3) SET QUERY — aggiunge o sovrascrive parametri di query su un URL esistente (aggiungi un token, un ' +
      'utm_source, un parametro di tracciamento); ' +
      '(4) REMOVE QUERY — rimuove parametri (togli i tracking param prima di salvare/condividere un link); ' +
      '(5) ENCODE / (6) DECODE — codifica/decodifica percent-encoding di un singolo valore per inserirlo in un ' +
      'URL o estrarlo. ' +
      'I parametri si passano come oggetto JSON, ognuno viene codificato correttamente. ' +
      'Output PARSE: { protocol, host, pathname, query, hash, origin, href } · altri: { href, query } o { result }. ' +
      "Use case: costruisci l'URL di una chiamata API con parametri dinamici e sicuri (BUILD); estrai il parametro " +
      '"code" dal redirect OAuth (PARSE → query.code); aggiungi un token di firma a un link webhook (SET QUERY); ' +
      'rimuovi gli utm_* da un URL prima di salvarlo nel CRM (REMOVE QUERY); codifica un termine di ricerca per ' +
      'una query (ENCODE).',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        defaultValue: 'parse',
        options: ['parse', 'build', 'setQuery', 'removeQuery', 'encode', 'decode'],
        help: 'parse = scomponi · build = componi · setQuery/removeQuery = modifica parametri · encode/decode.',
      },
      {
        key: 'url',
        label: 'URL',
        type: 'expression',
        required: false,
        defaultValue: 'input',
        help: "L'URL su cui operare (o il valore per encode/decode). Vuoto = input del nodo.",
        showIf: {
          field: 'operation',
          in: ['parse', 'setQuery', 'removeQuery', 'encode', 'decode'],
        },
      },
      {
        key: 'base',
        label: 'URL base',
        type: 'expression',
        required: false,
        placeholder: 'https://api.esempio.it',
        help: "L'origine + eventuale percorso base da cui partire.",
        showIf: { field: 'operation', equals: 'build' },
      },
      {
        key: 'path',
        label: 'Percorso',
        type: 'text',
        required: false,
        placeholder: '/v1/ordini',
        help: "Il percorso da impostare sull'URL base.",
        showIf: { field: 'operation', equals: 'build' },
      },
      {
        key: 'params',
        label: 'Parametri query (JSON)',
        type: 'json',
        required: false,
        placeholder: '{ "page": 1, "q": "caffè" }',
        help: 'Oggetto chiave/valore: ogni valore viene codificato automaticamente. (Per REMOVE: le chiavi da togliere.)',
        showIf: { field: 'operation', in: ['build', 'setQuery', 'removeQuery'] },
      },
    ],
    outputs: ['default'],
    outputContract: {
      notes: 'Tre forme secondo l\'operazione. SCOMPONENDO un indirizzo escono i suoi pezzi. MODIFICANDO i parametri o COSTRUENDO un indirizzo escono `href` e `query`. CODIFICANDO o decodificando esce solo `result`.',
      fields: [
        { name: 'protocol', type: 'string', desc: 'Lo schema, per esempio \'https:\'. Solo scomponendo.' },
        { name: 'host', type: 'string', desc: 'Il nome del server con la porta, se c\'e`. Solo scomponendo.' },
        { name: 'hostname', type: 'string', desc: 'Il solo nome del server. Solo scomponendo.' },
        { name: 'port', type: 'string', desc: 'La porta. Vuota se e` quella predefinita. Solo scomponendo.' },
        { name: 'pathname', type: 'string', desc: 'Il percorso. Solo scomponendo.' },
        { name: 'query', type: 'object', desc: 'I parametri come oggetto. Scomponendo, modificando e costruendo.' },
        { name: 'hash', type: 'string', desc: 'Il frammento dopo il cancelletto. Solo scomponendo.' },
        { name: 'origin', type: 'string', desc: 'Schema e server insieme. Solo scomponendo.' },
        { name: 'href', type: 'string', desc: 'L\'indirizzo completo. Scomponendo, modificando e costruendo.' },
        { name: 'result', type: 'string', desc: 'Il testo codificato o decodificato. Solo con quelle due operazioni.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: urlExecutor,
};
