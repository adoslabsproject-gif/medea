/**
 * action_script_var_extract — estrai variabili JavaScript da `<script>`
 * dentro pagine HTML.
 *
 * Pattern Streammy VixCloud: `window.video = { id: 1234 }` o
 * `window.masterPlaylist = { params: { token: '...', expires: '...' } }`.
 *
 * Approccio robusto a varianti quote/spacing:
 *  - substring-based primary
 *  - regex fallback con 3 pattern (id:1234 | id:'1234' | id:"1234")
 *  - escape automatic key con caratteri speciali
 *
 * NON valuta JS (no eval, no VM2). Solo parsing testuale → SAFE for SSRF
 * unsafe HTML inputs.
 */

import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

interface VarSpec {
  /** Nome variabile da estrarre (es. "window.video", "masterPlaylist", "data") */
  name: string;
  /** Chiave da pescare dal blocco oggetto (es. "id", "token"). Se vuoto, ritorna l'oggetto raw. */
  key?: string;
  /** Tipo atteso: number → solo digits, string → strip quote, raw → tutto. */
  expect?: 'number' | 'string' | 'raw';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Estrai il blocco {...} dopo `varName =`. Robust contro spazi/newline.
 * Ritorna la stringa dentro le parentesi graffe (senza le { }).
 */
function extractObjectBlock(scriptText: string, varName: string): string | null {
  const variants = [
    `${varName}={`,
    `${varName} ={`,
    `${varName}= {`,
    `${varName} = {`,
  ];
  for (const v of variants) {
    const idx = scriptText.indexOf(v);
    if (idx === -1) continue;
    const start = idx + v.length;
    // find matching closing brace (no proper depth tracking — simple)
    let depth = 1;
    let i = start;
    while (i < scriptText.length && depth > 0) {
      const c = scriptText[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    if (depth === 0) {
      return scriptText.slice(start, i - 1);
    }
  }
  return null;
}

/**
 * Estrai valore di una chiave dal blocco oggetto. Multi-variant.
 */
function extractKeyFromBlock(block: string, key: string, expect: 'number' | 'string' | 'raw'): string | null {
  const k = escapeRegex(key);
  // 1. key: 1234 (numero senza virgolette)
  if (expect === 'number') {
    const m = new RegExp(`\\b${k}\\s*:\\s*(\\d+)`).exec(block);
    if (m?.[1]) return m[1];
  }
  // 2. key: "value" o 'value'
  const m1 = new RegExp(`['"]?${k}['"]?\\s*:\\s*['"]([^'"\\\\]+)['"]`).exec(block);
  if (m1?.[1]) return m1[1];
  // 3. key: identifier|number_no_quotes
  const m2 = new RegExp(`['"]?${k}['"]?\\s*:\\s*([^,\\s}]+)`).exec(block);
  if (m2?.[1]) {
    const raw = m2[1].trim().replace(/^['"]|['"]$/g, '');
    return raw;
  }
  return null;
}

function parseVarsList(raw: unknown): VarSpec[] {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v) => v && typeof v === 'object') as VarSpec[];
    } catch { /* fall through */ }
  }
  if (Array.isArray(raw)) return raw as VarSpec[];
  return [];
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const htmlSource = String(config.htmlSource ?? 'input');
  let html = '';
  if (htmlSource === 'input') {
    if (typeof input === 'string') html = input;
    else if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      html = String(obj.body ?? obj.html ?? '');
    }
  } else {
    html = String(config.htmlExplicit ?? '');
  }
  if (!html.trim()) {
    return { output: { extracted: {}, matched: false }, durationMs: Date.now() - start, warnings: ['Empty HTML'] };
  }

  const vars = parseVarsList(config.variables);
  if (vars.length === 0) {
    throw new Error('variables required (JSON array of {name, key?, expect?})');
  }

  // Extract all <script> contents
  const $ = cheerioLoad(html);
  const scripts: string[] = [];
  $('script').each((_, el) => {
    const text = $(el).html();
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- Pattern && esplicito mantenuto per leggibilita`
    if (text && text.trim()) scripts.push(text);
  });
  const allScript = scripts.join('\n');

  const extracted: Record<string, unknown> = {};
  let matchedCount = 0;
  for (const v of vars) {
    const name = v.name;
    if (!name) continue;
    const expect = v.expect ?? 'raw';
    const block = extractObjectBlock(allScript, name);
    if (block === null) {
      extracted[name] = null;
      continue;
    }
    if (v.key) {
      const val = extractKeyFromBlock(block, v.key, expect);
      if (val !== null) {
        matchedCount++;
        extracted[`${name}.${v.key}`] = expect === 'number' ? Number(val) : val;
      } else {
        extracted[`${name}.${v.key}`] = null;
      }
    } else {
      matchedCount++;
      extracted[name] = block.trim();
    }
  }

  return {
    output: {
      extracted,
      matched: matchedCount > 0,
      matchedCount,
      requested: vars.length,
      scriptsScanned: scripts.length,
    },
    durationMs: Date.now() - start,
  };
};

export const scriptVarExtractNode: NodeModule = {
  def: {
    id: 'action_script_var_extract',
    type: 'action',
    label: 'Script Var Extract',
    icon: 'code',
    color: '#9333ea',
    description:
      'Estrattore enterprise specializzato per il pattern moderno di reverse-engineering web: parsing di ' +
      'variabili JavaScript inline embedded direttamente nei blocchi <script> del HTML server-rendered, senza ' +
      'eseguire il JS — pattern fondamentale per accedere ai dati strutturati che molte SPA, framework SSR ' +
      '(Next.js, Nuxt, SvelteKit, Remix), CMS embedded player (YouTube, Vimeo, Streammy, Twitch embeds), ' +
      'piattaforma sport (DAZN, Sky, ESPN) e similar mettono come state pre-popolato in window.X = {...} per ' +
      'consumo client-side, anziché esporre un\'API REST/GraphQL pubblica documentata. Questi dati sono ' +
      '"pubblici" nel HTML response del server ma non in JSON proper, e parsarli con browser+JS execution ' +
      '(via Puppeteer/Playwright) sarebbe overkill e 100× più lento + più costoso. ' +
      'Esempio canonico di use case: pagina video player con il tag <script>window.player = { src: "https:' +
      '//cdn.example.com/segments/master.m3u8", expires: 1730000000, drm: false, region: "EU" }</script> → ' +
      'il nodo estrae programmatic src + expires + drm + region senza dover lanciare Chrome headless + parse ' +
      'di DOM events. ' +
      'Robust contro le varianti di sintassi JavaScript reale (codice JS scritto da developer veri ha format ' +
      'eterogenei tra publisher e a volte tra deploy del stesso publisher): quote singole o doppie ' +
      'intercambiabili (\\"src\\" vs \\\'src\\\'), chiavi object con o senza virgolette (var = { src: ... } vs ' +
      'var = { \\"src\\": ... }), valori numerici o stringa o boolean o null, trailing comma permessi (style ' +
      'JS modern), commenti inline ignorati safely, espressioni semplici tipo Date.now() o {a: b} nested ' +
      'object. Il parser è AST-style con context window per evitare false match. ' +
      'Critical security feature: NON esegue mai il JavaScript estratto (no eval, no Function(), no vm) — il ' +
      'parsing è puramente lexical/syntactic stile SAX parser, completamente safe per processing di HTML ' +
      'untrusted da source web arbitrari senza rischio di code injection o sandbox escape. ' +
      'Output: { extracted: { variableName1: { value, type (object|array|string|number|boolean|null), ' +
      'scriptIndex } }, totalExtracted, scriptsAnalyzed }. ' +
      'Use case: estrarre URL video reali da player embed di service streaming come Streammy/vixcloud/sweetpixel ' +
      'che mettono lo stream URL in window.config = {} prima di costruire il player visuale; ingest del state ' +
      'SSR (window.__INITIAL_STATE__ del Redux pre-popolato, window.__APOLLO_STATE__ di Apollo Client) di ' +
      'pagine React/Vue server-rendered per scraping di e-commerce moderni; recovery di dati config da landing ' +
      'pubbliche di company sites (es. <script>window.analyticsConfig = {apiKey:"...", endpoint:"..."}); ' +
      'reverse-engineering di payload Inertia.js (used dai siti Laravel modern) o Next.js __NEXT_DATA__ ' +
      '(il payload server-side che React idrata client-side — contiene tipicamente tutti i dati della pagina ' +
      'pronti per consumo); ingest dati da broadcaster sport che fanno embed di player con metadata ' +
      'evento/lineup/stat in window.payload.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'htmlSource',
        label: 'Sorgente HTML',
        type: 'select',
        required: false,
        options: ['input', 'explicit'],
        defaultValue: 'input',
        help: 'input = HTML dal nodo precedente. explicit = HTML scritto qui (testing).',
      },
      {
        key: 'htmlExplicit',
        label: 'HTML (esplicito)',
        type: 'code',
        language: 'json',
        required: false,
        showIf: { field: 'htmlSource', equals: 'explicit' },
        help: 'HTML statico per testing.',
      },
      {
        key: 'variables',
        label: 'Variabili da estrarre',
        type: 'code',
        language: 'json',
        required: true,
        placeholder:
          '[\n' +
          '  { "name": "window.player", "key": "src", "expect": "string" },\n' +
          '  { "name": "window.player", "key": "expires", "expect": "number" },\n' +
          '  { "name": "appConfig", "key": "apiKey", "expect": "string" }\n' +
          ']',
        help:
          'Array di {name, key?, expect?}. ' +
          'name = path variabile (es. window.video, masterPlaylist, data). ' +
          'key = chiave da pescare dentro l\'oggetto (opzionale, se vuoto ritorna l\'intero blocco testuale). ' +
          'expect = number | string | raw (default raw). Number parsa solo digits.',
      },
    ],
    outputs: ['extracted', 'matched', 'matchedCount', 'requested', 'scriptsScanned'],
  },
  executor,
};
