/**
 * action_js_unpack — deoffuscazione JavaScript packed.
 *
 * Porting da Streammy (Kotlin JsUnpacker.kt) per il catalogo FlowForge.
 * Pattern target: Dean Edwards `eval(function(p,a,c,k,e,d){...}(...))` packer
 * usato comunemente da player video (SuperVideo, MaxStream, Dropload),
 * obfuscator JS legacy, alcuni anti-tampering.
 *
 * Approccio:
 *  - SOLO parsing testuale (no eval, no Function(), no VM2). SSRF-safe.
 *  - Estrae: payload (`p`), base (`a`), count (`c`), keys (`k`), keywords.
 *  - Decodifica: ricostruisce sostituendo identificatori col loro keyword.
 *  - Loop: max 5 iterations (multi-pack nesting). Threshold protegge da DoS.
 *
 * NON deoffusca:
 *  - JsJiami (commercial obfuscator), AAEncode, JJEncode (formati esoterici)
 *  - Custom VM-based protection
 *
 * Legal: deoffuscazione di JS pubblicamente accessibile è LEGAL nella maggior
 * parte delle giurisdizioni (no DMCA circumvention se non DRM-bound).
 * L'utente è responsabile di rispettare ToS del sito target.
 */

import type { NodeModule, NodeExecutor } from '../types.js';

// Anti-ReDoS (H2): la versione precedente usava backreference `(['"])([\s\S]+?)\1` +
// lazy `[\s\S]+?` → backtracking catastrofico di V8 su JS ostile scaricato (≤5MB). RE2
// rifiuta le backreference (richiedono backtracking) quindi non è applicabile qui. Fix
// SENZA backref: stringhe quotate via classe NEGATA `[^']*`/`[^"]*` — si fermano al primo
// quote ESATTAMENTE come la lazy+backref (semantica identica), ma sono LINEARI (nessun
// backtracking possibile). I `[\s\S]*?` residui sono lazy seguiti da àncora letterale
// (`return p}`) → scansione singola O(n), non catastrofica.
// Gruppi: payload = $1|$2 (single|double quote), base = $3, count = $4, keywords = $5|$6.
const PACKER_PATTERN =
  /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*(?:r|d)\s*\)\s*\{[\s\S]*?return\s+p\s*\}\s*\(\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(?:'([^']*)'|"([^"]*)")/;

const MAX_UNPACK_ITERATIONS = 5;

interface UnpackResult {
  unpacked: string;
  iterations: number;
  variantsFound: string[];
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Tentativo singolo di unpack Dean Edwards. Ritorna stringa decodificata o
 * `null` se input non matcha pattern.
 */
function unpackDeanEdwards(source: string): string | null {
  const match = PACKER_PATTERN.exec(source);
  if (!match) return null;

  // payload e keywords: alternativa single|double quote (vedi PACKER_PATTERN).
  const payload = match[1] ?? match[2] ?? '';
  const base = parseInt(match[3] ?? '0', 10);
  const count = parseInt(match[4] ?? '0', 10);
  const keywordsStr = match[5] ?? match[6] ?? '';

  if (base < 2 || base > 62 || count <= 0 || !payload) return null;

  const keywords = keywordsStr.split('|');
  if (keywords.length < count) return null;

  // Substitution: ogni identificatore "abc" → keyword[radix-decoded(abc)]
  // Regex `\b[\w]+\b` cattura tutti gli identifier-like.
  const decoded = payload.replace(/\b\w+\b/g, (token) => {
    let n = 0;
    for (let i = 0; i < token.length; i++) {
      const c = token.charCodeAt(i);
      const v = c >= 97 ? c - 87 : c - 48;
      if (v < 0 || v >= base) return token;
      n = n * base + v;
    }
    const kw = keywords[n];
    return kw !== undefined && kw !== '' ? kw : token;
  });

  return decoded;
}

export function unpackJs(source: string, options: { maxIterations?: number } = {}): UnpackResult {
  const maxIter = options.maxIterations ?? MAX_UNPACK_ITERATIONS;
  const variants: string[] = [];
  let current = source;
  let iterations = 0;

  while (iterations < maxIter) {
    const next = unpackDeanEdwards(current);
    if (next === null) break;
    variants.push('dean-edwards');
    current = next;
    iterations++;
  }

  return {
    unpacked: current,
    iterations,
    variantsFound: variants,
    confidence: iterations === 0 ? 'low' : iterations >= 2 ? 'high' : 'medium',
  };
}

interface JsUnpackConfig {
  source?: 'input' | 'explicit';
  htmlOrScript?: string;
  maxIterations?: number;
}

const jsUnpackExecute: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
  const cfg = (config ?? {}) as JsUnpackConfig;
  const inp = (input ?? {}) as { html?: string; source?: string };

  const src = cfg.source === 'explicit' ? (cfg.htmlOrScript ?? '') : (inp.html ?? inp.source ?? '');
  if (!src || typeof src !== 'string') {
    return {
      output: {
        ok: false,
        error: 'js_unpack: no source provided (expected input.html or config.htmlOrScript)',
      },
      durationMs: Date.now() - start,
    };
  }
  if (src.length > 5_000_000) {
    return {
      output: {
        ok: false,
        error: `js_unpack: source troppo grande (${(src.length / 1024 / 1024).toFixed(1)}MB), max 5MB`,
      },
      durationMs: Date.now() - start,
    };
  }

  const result = unpackJs(src, { maxIterations: cfg.maxIterations ?? MAX_UNPACK_ITERATIONS });

  return {
    output: {
      ok: true,
      unpacked: result.unpacked,
      iterations: result.iterations,
      variantsFound: result.variantsFound,
      confidence: result.confidence,
      originalLength: src.length,
      unpackedLength: result.unpacked.length,
      sizeRatio: src.length > 0 ? +(result.unpacked.length / src.length).toFixed(2) : 0,
    },
    durationMs: Date.now() - start,
  };
};

export const jsUnpackNode: NodeModule = {
  def: {
    id: 'action_js_unpack',
    type: 'action',
    label: 'JS Unpacker',
    icon: 'package',
    color: '#9333ea',
    description:
      'Deoffuscazione JavaScript packed Dean Edwards (`eval(function(p,a,c,k,e,d){...}...)`)— pattern usato da player video legacy, ' +
      'obfuscator JS commerciali e alcuni anti-tampering. Estrai il codice originale senza eseguire nulla (no eval, no VM).\n\n' +
      'Use case: pagina che embed `<script>eval(function(p,a,c,k,e,d){return p}(...))</script>` con dentro l\'URL m3u8 cifrato → unpack → estrai con `action_script_var_extract`.\n\n' +
      'Loop multi-pack: max 5 iterazioni (default). Confidence high se ≥2 round, medium se 1, low se nessun pattern matched.\n\n' +
      'SAFE: solo parsing testuale, no eval/Function/VM. Input max 5MB per anti-DoS.',
    version: '1.0.0',
    configFields: [
      {
        key: 'source',
        label: 'Sorgente',
        type: 'select',
        required: false,
        options: ['input', 'explicit'],
        defaultValue: 'input',
        help: 'input = HTML/JS dal nodo precedente (ctx.input.html). explicit = scritto qui (testing).',
      },
      {
        key: 'htmlOrScript',
        label: 'HTML/JS esplicito',
        type: 'code',
        language: 'javascript',
        required: false,
        showIf: { field: 'source', equals: 'explicit' },
        help: 'Codice da unpackare (per testing). In produzione usa input.',
      },
      {
        key: 'maxIterations',
        label: 'Max iterazioni unpacker',
        type: 'number',
        required: false,
        defaultValue: '5',
        help: 'Anti-DoS: limita loop su nesting multipli. Range 1-10. Default 5 = sufficiente per >99% casi reali.',
      },
    ],
    outputs: ['unpacked', 'iterations', 'variantsFound', 'confidence', 'sizeRatio', 'originalLength', 'unpackedLength', 'ok'],
  },
  executor: jsUnpackExecute,
};
