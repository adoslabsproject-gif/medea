/**
 * Code-language detector — condiviso tra auto-fix (Layer C) e quality-gate.
 *
 * Problema reale (user-segnalato 2026-06-09): l'AI scaffold genera un nodo
 * `action_run_js` ma vi incolla codice **Python** (il default template del
 * nodo `action_run_python`: `import json, os` / `json.loads` / `print(...)`),
 * insieme ai parametri Python-only `parseStdoutJson`/`allowNetwork`. A runtime
 * isolated-vm fallisce al parse (`import` non è JS valido) → nodo non
 * eseguibile, ma zod + quality-gate lo lasciavano passare.
 *
 * I due nodi code di FlowForge:
 *   - `action_run_js`     → isolated-vm in-process, JavaScript, `return <value>`,
 *     NO import/require/fetch. Params: code, timeoutMs, memoryLimitMb.
 *   - `action_run_python` → microservizio Docker code-runner, Python, output via
 *     stdout. Params: code, timeoutMs, parseStdoutJson, allowNetwork.
 *
 * Questo modulo classifica un blob di codice come `python` | `javascript` |
 * `ambiguous`. È volutamente CONSERVATIVO: classifica solo quando vede segnali
 * ESCLUSIVI di un linguaggio (token che NON possono comparire nell'altro). In
 * caso di dubbio ritorna `ambiguous` → i consumer NON toccano il nodo (no
 * falsi positivi su frammenti banali validi in entrambi).
 *
 * Pure function, zero dipendenze, zero side-effect — testabile a unità.
 */

export type CodeLang = 'python' | 'javascript' | 'ambiguous';

/**
 * Segnali ESCLUSIVI di Python: costrutti che in JavaScript sono un syntax
 * error (o un identificatore non-builtin che il sandbox run_js non espone).
 */
const PYTHON_SIGNALS: readonly { re: RegExp; weight: number; tag: string }[] = [
  // `import json, os` / `import sys` — in JS è `import x from '...'` (ha sempre `from`+stringa).
  { re: /^[ \t]*import[ \t]+[A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*[ \t]*(?:#.*)?$/m, weight: 3, tag: 'py-import' },
  { re: /^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+/m, weight: 3, tag: 'py-from-import' },
  // `def name(` — JS usa `function`.
  { re: /\bdef[ \t]+[A-Za-z_]\w*[ \t]*\(/, weight: 3, tag: 'py-def' },
  // `elif` — non esiste in JS.
  { re: /\belif\b/, weight: 3, tag: 'py-elif' },
  // `print(` chiamato come statement — JS non ha `print` builtin nel sandbox.
  { re: /(?:^|[^.\w])print[ \t]*\(/, weight: 2, tag: 'py-print' },
  // stdlib-isms tipiche del template Python di FlowForge.
  { re: /\bos\.environ\b/, weight: 2, tag: 'py-os-environ' },
  { re: /\bjson\.(?:loads|dumps)\b/, weight: 2, tag: 'py-json-loads' },
  // f-string `f"...{x}"` — sintassi solo Python.
  { re: /\bf"[^"\n]*\{[^}\n]*\}/, weight: 2, tag: 'py-fstring-dq' },
  { re: /\bf'[^'\n]*\{[^}\n]*\}/, weight: 2, tag: 'py-fstring-sq' },
  // costanti Python (capitalizzate) — JS usa true/false/null lowercase.
  { re: /(?:^|[^.\w])(?:True|False|None)\b/, weight: 1, tag: 'py-const' },
  // builtins comuni: len(/range(/dict(/str.format
  { re: /(?:^|[^.\w])(?:len|range|enumerate|isinstance)[ \t]*\(/, weight: 1, tag: 'py-builtin' },
  // dunder
  { re: /\b__\w+__\b/, weight: 1, tag: 'py-dunder' },
  // block colon: `:` a fine riga seguito da indentazione (if/for/while/def/with/try).
  { re: /\b(?:if|for|while|with|try|except|else|class)\b[^\n]*:[ \t]*(?:#.*)?\n[ \t]+\S/, weight: 2, tag: 'py-block-colon' },
];

/**
 * Segnali ESCLUSIVI di JavaScript: costrutti che in Python sono un syntax
 * error.
 */
const JS_SIGNALS: readonly { re: RegExp; weight: number; tag: string }[] = [
  // `const x =` / `let x =` / `var x =` — keyword non esistenti in Python.
  { re: /\b(?:const|let|var)[ \t]+[A-Za-z_$][\w$]*[ \t]*=/, weight: 3, tag: 'js-decl' },
  // arrow function `=>`.
  { re: /=>/, weight: 3, tag: 'js-arrow' },
  // `function (` / `function name(`.
  { re: /\bfunction[ \t]*\*?[ \t]*[A-Za-z_$]*[ \t]*\(/, weight: 3, tag: 'js-function' },
  // strict equality — Python non ha `===`/`!==`.
  { re: /===|!==/, weight: 2, tag: 'js-strict-eq' },
  // console.log/error/warn.
  { re: /\bconsole\.(?:log|error|warn|info|debug)[ \t]*\(/, weight: 2, tag: 'js-console' },
  // JSON.parse/stringify.
  { re: /\bJSON\.(?:parse|stringify)[ \t]*\(/, weight: 2, tag: 'js-json' },
  // template literal `` `...${x}...` ``.
  { re: /`[^`]*\$\{[^}]*\}/, weight: 2, tag: 'js-template-literal' },
  // require(...) o import ... from '...'.
  { re: /\brequire[ \t]*\(/, weight: 2, tag: 'js-require' },
  { re: /\bimport\b[^\n]*\bfrom\b[ \t]*['"]/, weight: 2, tag: 'js-es-import' },
  // null/undefined literali JS (Python usa None).
  { re: /(?:^|[^.\w])(?:undefined)\b/, weight: 1, tag: 'js-undefined' },
  // optional chaining / nullish coalescing — solo JS moderno.
  { re: /\?\.[A-Za-z_$]|(?<![?])\?\?(?!\?)/, weight: 1, tag: 'js-optional-chain' },
  // `${...}` interpolation o backtick (debole).
  { re: /(?:^|[^.\w])(?:Array|Object|Math|Number|Boolean)\.[A-Za-z]/, weight: 1, tag: 'js-global-method' },
];

export interface CodeLangScore {
  lang: CodeLang;
  pythonScore: number;
  javascriptScore: number;
  /** Tag dei segnali matchati, per logging/diagnostica/test. */
  matched: { python: string[]; javascript: string[] };
}

/**
 * Analizza un blob di codice e ritorna la classificazione + lo score grezzo.
 * Esposto separato da `detectCodeLanguage` per i test (verificano i match).
 */
export function scoreCodeLanguage(code: string): CodeLangScore {
  const empty: CodeLangScore = {
    lang: 'ambiguous',
    pythonScore: 0,
    javascriptScore: 0,
    matched: { python: [], javascript: [] },
  };
  if (typeof code !== 'string' || code.trim().length === 0) return empty;

  let pythonScore = 0;
  let javascriptScore = 0;
  const matchedPy: string[] = [];
  const matchedJs: string[] = [];

  for (const { re, weight, tag } of PYTHON_SIGNALS) {
    if (re.test(code)) {
      pythonScore += weight;
      matchedPy.push(tag);
    }
  }
  for (const { re, weight, tag } of JS_SIGNALS) {
    if (re.test(code)) {
      javascriptScore += weight;
      matchedJs.push(tag);
    }
  }

  let lang: CodeLang = 'ambiguous';
  // Richiediamo (a) uno score netto a favore di un linguaggio e (b) almeno un
  // segnale forte (weight>=2 → almeno 2 di score). Evita switch su un singolo
  // segnale debole accidentale (es. la sola parola "None"/"undefined").
  const DECISIVE = 2;
  if (pythonScore >= DECISIVE && pythonScore > javascriptScore) lang = 'python';
  else if (javascriptScore >= DECISIVE && javascriptScore > pythonScore) lang = 'javascript';

  return {
    lang,
    pythonScore,
    javascriptScore,
    matched: { python: matchedPy, javascript: matchedJs },
  };
}

/**
 * Classificazione semplice: `python` | `javascript` | `ambiguous`.
 */
export function detectCodeLanguage(code: string): CodeLang {
  return scoreCodeLanguage(code).lang;
}

/** Il defId code che corrisponde a un linguaggio rilevato. */
export const CODE_NODE_FOR_LANG: Readonly<Record<'python' | 'javascript', string>> = {
  python: 'action_run_python',
  javascript: 'action_run_js',
};

/** Mappa inversa: defId → linguaggio atteso del campo `code`. */
export const LANG_FOR_CODE_NODE: ReadonlyMap<string, 'python' | 'javascript'> = new Map([
  ['action_run_python', 'python'],
  ['action_run_js', 'javascript'],
]);
