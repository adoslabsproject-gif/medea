/**
 * action_url_template — costruisce URL dinamici da template + query params.
 *
 * Pattern Streammy VixCloud: dopo aver estratto videoId/token/expires, costruisci:
 *   https://${host}/playlist/${videoId}?token=${token}&expires=${expires}&b=1&h=1&language=it
 *
 * Sintassi template: ${path.to.value} pesca da input o da `vars`.
 * Query params: map { key: value | "${expr}" }, encoding automatico.
 * Conditional flags: lista di { if: boolean | "${expr}", add: { key, value } }.
 */

import type { NodeModule, NodeExecutor } from '../types.js';

function lookupValue(path: string, ctx: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function interpolate(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const v = lookupValue(expr.trim(), ctx);
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

interface ConditionalFlag {
  if: string | boolean;
  add: Record<string, string | number | boolean>;
}

function parseConditionals(raw: unknown): ConditionalFlag[] {
  if (typeof raw === 'string' && raw.trim()) {
    try { return parseConditionals(JSON.parse(raw)); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((it) => it && typeof it === 'object') as ConditionalFlag[];
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const template = String(config.template ?? '');
  if (!template) throw new Error('template required (es. "https://${host}/playlist/${videoId}")');

  // Context per interpolazione: input + vars
  const varsRaw = config.vars;
  let extraVars: Record<string, unknown> = {};
  if (typeof varsRaw === 'string' && varsRaw.trim()) {
    try { extraVars = JSON.parse(varsRaw) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (varsRaw && typeof varsRaw === 'object') {
    extraVars = varsRaw as Record<string, unknown>;
  }
  const ctx: Record<string, unknown> = {
    input: input ?? {},
    ...((input && typeof input === 'object') ? input as Record<string, unknown> : {}),
    ...extraVars,
  };

  // 1. Interpolate base URL
  const baseUrl = interpolate(template, ctx);

  // 2. Validate URL syntactically
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid URL after template interpolation: "${baseUrl}"`);
  }

  // 3. Query params (key-value map)
  const queryRaw = config.queryParams;
  let queryParams: Record<string, unknown> = {};
  if (typeof queryRaw === 'string' && queryRaw.trim()) {
    try { queryParams = JSON.parse(queryRaw) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (queryRaw && typeof queryRaw === 'object') {
    queryParams = queryRaw as Record<string, unknown>;
  }
  for (const [k, v] of Object.entries(queryParams)) {
    const interpolated = interpolate(String(v ?? ''), ctx);
    if (interpolated !== '') u.searchParams.append(k, interpolated);
  }

  // 4. Conditional flags
  const conditionals = parseConditionals(config.conditionalFlags);
  for (const flag of conditionals) {
    const condRaw = flag.if;
    const evaluated = typeof condRaw === 'string'
      ? toBool(interpolate(condRaw, ctx))
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- String() esplicito mantenuto per chiarezza tipo: input puo` essere stringificato da Zod ma TS ha widening
      : Boolean(condRaw);
    if (!evaluated) continue;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    for (const [k, v] of Object.entries(flag.add ?? {})) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
      const interpolated = interpolate(String(v ?? ''), ctx);
      if (interpolated !== '') u.searchParams.append(k, interpolated);
    }
  }

  return {
    output: {
      url: u.toString(),
      host: u.host,
      path: u.pathname,
      protocol: u.protocol,
      params: Object.fromEntries(u.searchParams.entries()),
    },
    durationMs: Date.now() - start,
  };
};

export const urlTemplateNode: NodeModule = {
  def: {
    id: 'action_url_template',
    type: 'action',
    label: 'URL Template Builder',
    icon: 'link',
    color: '#0891b2',
    description:
      'Costruisce URL dinamici da template `${var}` + query params + flag condizionali. Pattern enterprise per costruire URL finali (playlist HLS, API endpoint, signed URLs) dopo aver estratto token/id/params da pagine HTML.\n\n' +
      'Esempio: estrai videoId e token da pagina embed, poi costruisci https://${host}/playlist/${videoId}?token=${token}&expires=${expires}&language=it.\n\n' +
      'Sintassi: ${input.path.to.value} pesca da output del nodo precedente. ${customVar} pesca da Vars custom. Encoding URI automatico sui query params. Conditional flags: aggiungi query parametri solo se condizione vera.\n\n' +
      'Use case: (1) costruire URL HLS playlist con token + expires dopo extraction, (2) signed URL API per webhook callback, (3) deep-link mobile app con UTM tracking dinamico, (4) URL paginazione condizionale (page=N solo se >1).',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'template',
        label: 'URL template',
        type: 'text',
        required: true,
        placeholder: 'https://${host}/playlist/${videoId}',
        help:
          'URL template con interpolazione ${var}. Le variabili pescano da input dal nodo precedente o da Vars custom. ' +
          'Esempi: https://${input.host}/api/${input.id}, https://api.com/${user.name}/items.',
      },
      {
        key: 'queryParams',
        label: 'Query parameters',
        type: 'key-value',
        required: false,
        help:
          'Map key → value (anche con ${interpolation}). Esempio:\n' +
          '{ "token": "${input.token}", "language": "it", "format": "hls" }\n' +
          'Valori vuoti dopo interpolation vengono skippati.',
      },
      {
        key: 'conditionalFlags',
        label: 'Flag condizionali',
        type: 'code',
        language: 'json',
        required: false,
        placeholder:
          '[\n' +
          '  { "if": "${input.canPlayFHD}", "add": { "h": "1" } },\n' +
          '  { "if": "${input.hasB}", "add": { "b": "1" } }\n' +
          ']',
        help:
          'Array di {if, add}. if = boolean o ${expr}. add = map di params aggiunti SE condizione vera. ' +
          'Esempio: aggiungi "h=1" solo se canPlayFHD è true.',
      },
      {
        key: 'vars',
        label: 'Vars custom',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '{ "host": "vixcloud.co", "lang": "it" }',
        help: 'Variabili extra disponibili per interpolation (oltre a "input"). Esempio: host, region, version.',
      },
    ],
    outputs: ['url', 'host', 'path', 'protocol', 'params'],
  },
  executor,
};
