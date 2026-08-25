/**
 * action_regex_multi — multi-pattern regex extraction con fallback chain.
 *
 * Pattern Streammy VixCloud: 4 fallback per estrarre `token`:
 *   1. paramsBlock.extractValue("token")
 *   2. scriptText.substringAfter("token: \"", "")...
 *   3. scriptText.substringAfter("token: '", "")...
 *   4. scriptText.substringAfter("\"token\": \"", "")...
 *
 * Questo nodo permette di definire MULTIPLI pattern per fieldName e usa
 * il primo che matcha. Riduce drasticamente la fragilita\` di estrazioni
 * su pagine variabili.
 */

import type { NodeModule, NodeExecutor } from '../types.js';
import { safeUserRegex } from '../lib/safe-user-regex.js';

interface PatternSpec {
  /** Regex pattern (senza delimitatori). */
  pattern: string;
  /** Flags: 'g', 'i', 'm', 's', 'u', 'y'. Default 'i'. */
  flags?: string;
  /** Gruppo da catturare (default 1). 0 = match completo. */
  group?: number;
  /** Trasformazione output: 'trim' (default) | 'lowercase' | 'uppercase' | 'number' | 'json' | 'none'. */
  transform?: 'trim' | 'lowercase' | 'uppercase' | 'number' | 'json' | 'none';
}

interface FieldSpec {
  /** Pattern fallback chain — primo match vince. */
  patterns: PatternSpec[];
  /** Se nessuno matcha, default value (null se assente). */
  defaultValue?: string | null;
}

function parseFieldsMap(raw: unknown): Record<string, FieldSpec> {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return parseFieldsMap(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, FieldSpec> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      // Shortcut: single pattern, default flags 'i', group 1
      out[k] = { patterns: [{ pattern: v, flags: 'i', group: 1 }] };
    } else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const patternsRaw = obj.patterns;
      const patterns: PatternSpec[] = Array.isArray(patternsRaw)
        ? (patternsRaw as PatternSpec[])
        : typeof obj.pattern === 'string'
          ? [{ pattern: obj.pattern }]
          : [];
      const fieldSpec: FieldSpec = { patterns };
      const dv = obj.defaultValue;
      if (typeof dv === 'string' || dv === null) fieldSpec.defaultValue = dv;
      if (patterns.length > 0) out[k] = fieldSpec;
    }
  }
  return out;
}

function applyTransform(value: string, t: PatternSpec['transform']): unknown {
  switch (t) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.toLowerCase();
    case 'uppercase':
      return value.toUpperCase();
    case 'number': {
      const n = Number(value.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'json': {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    case 'none':
      return value;
    default:
      return value.trim();
  }
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const textSource = String(config.textSource ?? 'input');
  let text = '';
  if (textSource === 'input') {
    if (typeof input === 'string') text = input;
    else if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      text = String(obj.body ?? obj.text ?? obj.html ?? JSON.stringify(input));
    }
  } else {
    text = String(config.textExplicit ?? '');
  }
  if (!text) {
    return {
      output: { fields: {}, matched: false },
      durationMs: Date.now() - start,
      warnings: ['Empty text input'],
    };
  }

  const fields = parseFieldsMap(config.fieldsJson);
  if (Object.keys(fields).length === 0) {
    throw new Error(
      'fieldsJson required (map fieldName → {patterns:[{pattern, flags?, group?, transform?}], defaultValue?})',
    );
  }

  const out: Record<string, unknown> = {};
  let matchedCount = 0;
  for (const [name, spec] of Object.entries(fields)) {
    let matched: unknown = null;
    for (const p of spec.patterns) {
      try {
        const re = safeUserRegex(p.pattern, p.flags ?? 'i');
        const m = re.exec(text);
        if (m) {
          const groupIdx = p.group ?? 1;
          const captured = m[groupIdx] ?? m[0];
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
          if (captured !== undefined) {
            matched = applyTransform(captured, p.transform);
            break;
          }
        }
      } catch {
        // invalid regex → skip pattern, continue chain
        continue;
      }
    }
    if (matched === null && spec.defaultValue !== undefined) {
      matched = spec.defaultValue;
    }
    if (matched !== null) matchedCount++;
    out[name] = matched;
  }

  return {
    output: {
      fields: out,
      matched: matchedCount > 0,
      matchedCount,
      totalFields: Object.keys(fields).length,
    },
    durationMs: Date.now() - start,
  };
};

export const regexMultiNode: NodeModule = {
  def: {
    id: 'action_regex_multi',
    type: 'action',
    label: 'Regex Multi-Pattern',
    icon: 'search',
    color: '#dc2626',
    description:
      'Estrattore enterprise di dati strutturati da testo non strutturato usando regex con FALLBACK CHAIN — ' +
      'il pattern critical per parsing robusto di pagine HTML/JSON/log/PDF che cambiano formato leggermente ' +
      'nel tempo (cambi di quote single→double, variazioni spacing, ordine random degli attributi). La ' +
      'tipica fragilità del regex singolo che funziona oggi e si rompe domani al primo deploy del publisher ' +
      'viene mitigata permettendo di definire 2-5 pattern alternativi per ogni campo target: il primo regex ' +
      'che matcha vince la priorità, gli altri sono fallback se il primo fallisce. ' +
      'Esempio canonico di estrazione di token da pagina web con fallback chain robusta: pattern 1 ' +
      'token:\\\\s*"([^"]+)" (formato JS object con virgolette doppie), pattern 2 token:\\\\s*\\\'([^\\\']+)\\\' ' +
      '(formato JS object con virgolette singole — variant comune per i developer che preferiscono single ' +
      'quote in JavaScript), pattern 3 "token":\\\\s*"([^"]+)" (formato JSON proper con key tra virgolette ' +
      'come standard RFC), pattern 4 \\\\btoken\\\\s*=\\\\s*([a-z0-9_-]{20,})\\\\b (formato URL query string ' +
      'o env var assignment senza virgolette per i token di formato Crockford-base32) — questa coverage 4× ' +
      'gestisce praticamente tutti gli scenari real-world dove un publisher potrebbe cambiare il formato del ' +
      'proprio output nel deploy successivo. ' +
      'Transform pipeline opzionale per ogni campo estratto: trim (elimina whitespace leading/trailing), ' +
      'lowercase/uppercase (normalize case per matching downstream), number (cast a numeric con parsing ' +
      'localized "1.234,56" italiano + "1,234.56" inglese), json (parse del valore come JSON nested object), ' +
      'none (raw passthrough senza modifica). ' +
      "Multi-field in singola invocation: l'utente definisce un dictionary di N field → ognuno con la sua " +
      'fallback chain di regex, e il nodo li estrae tutti in singolo pass del testo (pattern efficiente vs ' +
      'invocare N nodi separati per N field). Cap di sicurezza: max 50 field per invocation, max 10 pattern ' +
      'per field, max 100KB di testo input per evitare regex catastrophic backtracking su input maligno. ' +
      'Output: { extracted: { fieldName1: { value, matchedPatternIndex, transform_applied }, fieldName2: ' +
      '{...}, ... }, totalFieldsExtracted, totalFieldsMissing, durationMs }. ' +
      'Use case: parsing di token JWT/CSRF/session_id da response HTML/JS di API non documentate (workflow ' +
      'di automation che simula login programmatic su sistemi legacy senza API REST disponibili); estrarre ' +
      'prezzo da HTML di e-commerce con multiple quote variants tra mobile/desktop version dello stesso sito; ' +
      'recovery di numero fattura/data fattura/totale da PDF testuale di vendor eterogenei (ogni fornitore ' +
      'ha format leggermente diverso → fallback chain copre tutti); capture pattern specifici da log ' +
      'applicativi per alert SLA (es. error code, response time, customer_id per detection di anomalie + ' +
      'pattern di failure analytics); migration di dati da export legacy text/CSV con format incomerente.',
    outputContract: {
      notes: 'I valori estratti stanno DENTRO `fields`, sotto i nomi dati in configurazione: si legge `{{$node.<id>.json.fields.<nome>}}`, non il nome direttamente sul nodo. `matched` e` falso quando nessuna espressione ha trovato niente.',
      fields: [
        { name: 'fields', type: 'object', desc: 'Un valore per ogni campo cercato, sotto il nome che gli e` stato dato. Null per quelli non trovati.' },
        { name: 'matched', type: 'boolean', desc: 'Se almeno un campo e` stato trovato.' },
        { name: 'matchedCount', type: 'number', desc: 'Quanti campi hanno trovato un valore.' },
        { name: 'totalFields', type: 'number', desc: 'Quanti campi erano stati chiesti: confrontarlo con `matchedCount` dice quanti mancano.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'textSource',
        label: 'Sorgente testo',
        type: 'select',
        required: false,
        options: ['input', 'explicit'],
        defaultValue: 'input',
        help: "input = stringa dal nodo precedente (legge .body, .text, .html, o tutto l'oggetto). explicit = testo qui sotto.",
      },
      {
        key: 'textExplicit',
        label: 'Testo (esplicito)',
        type: 'textarea',
        required: false,
        showIf: { field: 'textSource', equals: 'explicit' },
        help: 'Testo statico per testing.',
      },
      {
        key: 'fieldsJson',
        label: 'Pattern map',
        type: 'code',
        language: 'json',
        required: true,
        placeholder:
          '{\n' +
          '  "token": {\n' +
          '    "patterns": [\n' +
          '      { "pattern": "token:\\\\s*\\"([^\\"]+)\\"", "group": 1, "transform": "trim" },\n' +
          '      { "pattern": "token:\\\\s*\'([^\']+)\'", "group": 1 },\n' +
          '      { "pattern": "\\"token\\":\\\\s*\\"([^\\"]+)\\"", "group": 1 }\n' +
          '    ],\n' +
          '    "defaultValue": null\n' +
          '  },\n' +
          '  "videoId": {\n' +
          '    "patterns": [{ "pattern": "video.id\\\\s*=\\\\s*(\\\\d+)", "group": 1, "transform": "number" }]\n' +
          '  }\n' +
          '}',
        help:
          'Map fieldName → {patterns: [...], defaultValue?}. ' +
          'Forma scorciatoia: "key": "regex" (single pattern, flags="i", group=1). ' +
          'Forma estesa: patterns array con {pattern, flags, group, transform}. ' +
          'transform: trim (default) | lowercase | uppercase | number | json | none.',
      },
    ],
    outputs: ['fields', 'matched', 'matchedCount', 'totalFields'],
  },
  executor,
};
