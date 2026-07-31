/**
 * Riconosce se un blocco di codice è Python o JavaScript.
 *
 * Serve perché il modello, quando genera un nodo `action_run_js`, ogni tanto
 * ci incolla dentro Python (`import json`, `print(...)`) — e viceversa. La
 * validazione strutturale non se ne accorge: il campo `code` è una stringa e
 * una stringa è. A runtime il sandbox fallisce al primo parse.
 *
 * La classificazione è prudente per costruzione: decide solo davanti a
 * segnali ESCLUSIVI di un linguaggio, quelli che nell'altro sarebbero un
 * errore di sintassi. Nel dubbio restituisce `ambiguous` e chi chiama non
 * tocca nulla.
 */

export type CodeLang = 'python' | 'javascript' | 'ambiguous';

interface Signal {
  re: RegExp;
  weight: number;
  tag: string;
}

/** Costrutti che in JavaScript sarebbero un errore di sintassi. */
const PYTHON_SIGNALS: readonly Signal[] = [
  {
    re: /^[ \t]*import[ \t]+[A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*[ \t]*(?:#.*)?$/m,
    weight: 3,
    tag: 'py-import',
  },
  { re: /^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+/m, weight: 3, tag: 'py-from-import' },
  { re: /\bdef[ \t]+[A-Za-z_]\w*[ \t]*\(/, weight: 3, tag: 'py-def' },
  { re: /\belif\b/, weight: 3, tag: 'py-elif' },
  { re: /(?:^|[^.\w])print[ \t]*\(/, weight: 2, tag: 'py-print' },
  { re: /\bos\.environ\b/, weight: 2, tag: 'py-os-environ' },
  { re: /\bjson\.(?:loads|dumps)\b/, weight: 2, tag: 'py-json-loads' },
  { re: /\bf"[^"\n]*\{[^}\n]*\}/, weight: 2, tag: 'py-fstring-dq' },
  { re: /\bf'[^'\n]*\{[^}\n]*\}/, weight: 2, tag: 'py-fstring-sq' },
  { re: /(?:^|[^.\w])(?:True|False|None)\b/, weight: 1, tag: 'py-const' },
  { re: /(?:^|[^.\w])(?:len|range|enumerate|isinstance)[ \t]*\(/, weight: 1, tag: 'py-builtin' },
  { re: /\b__\w+__\b/, weight: 1, tag: 'py-dunder' },
  {
    re: /\b(?:if|for|while|with|try|except|else|class)\b[^\n]*:[ \t]*(?:#.*)?\n[ \t]+\S/,
    weight: 2,
    tag: 'py-block-colon',
  },
];

/** Costrutti che in Python sarebbero un errore di sintassi. */
const JS_SIGNALS: readonly Signal[] = [
  { re: /\b(?:const|let|var)[ \t]+[A-Za-z_$][\w$]*[ \t]*=/, weight: 3, tag: 'js-decl' },
  { re: /=>/, weight: 3, tag: 'js-arrow' },
  { re: /\bfunction[ \t]*\*?[ \t]*[A-Za-z_$]*[ \t]*\(/, weight: 3, tag: 'js-function' },
  { re: /===|!==/, weight: 2, tag: 'js-strict-eq' },
  { re: /\bconsole\.(?:log|error|warn|info|debug)[ \t]*\(/, weight: 2, tag: 'js-console' },
  { re: /\bJSON\.(?:parse|stringify)[ \t]*\(/, weight: 2, tag: 'js-json' },
  { re: /`[^`]*\$\{[^}]*\}/, weight: 2, tag: 'js-template-literal' },
  { re: /\brequire[ \t]*\(/, weight: 2, tag: 'js-require' },
  { re: /\bimport\b[^\n]*\bfrom\b[ \t]*['"]/, weight: 2, tag: 'js-es-import' },
  { re: /(?:^|[^.\w])(?:undefined)\b/, weight: 1, tag: 'js-undefined' },
  { re: /\?\.[A-Za-z_$]|(?<![?])\?\?(?!\?)/, weight: 1, tag: 'js-optional-chain' },
  {
    re: /(?:^|[^.\w])(?:Array|Object|Math|Number|Boolean)\.[A-Za-z]/,
    weight: 1,
    tag: 'js-global-method',
  },
];

export interface CodeLangScore {
  lang: CodeLang;
  pythonScore: number;
  javascriptScore: number;
  /** I segnali riconosciuti, utili in diagnostica e nei test. */
  matched: { python: string[]; javascript: string[] };
}

function score(code: string, signals: readonly Signal[]): { total: number; tags: string[] } {
  let total = 0;
  const tags: string[] = [];
  for (const { re, weight, tag } of signals) {
    if (re.test(code)) {
      total += weight;
      tags.push(tag);
    }
  }
  return { total, tags };
}

export function scoreCodeLanguage(code: string): CodeLangScore {
  if (typeof code !== 'string' || code.trim().length === 0) {
    return {
      lang: 'ambiguous',
      pythonScore: 0,
      javascriptScore: 0,
      matched: { python: [], javascript: [] },
    };
  }

  const py = score(code, PYTHON_SIGNALS);
  const js = score(code, JS_SIGNALS);

  // Serve uno scarto netto E almeno un segnale forte: un solo indizio debole
  // (la parola "None", un "undefined" di passaggio) non basta a decidere.
  const DECISIVE = 2;
  let lang: CodeLang = 'ambiguous';
  if (py.total >= DECISIVE && py.total > js.total) lang = 'python';
  else if (js.total >= DECISIVE && js.total > py.total) lang = 'javascript';

  return {
    lang,
    pythonScore: py.total,
    javascriptScore: js.total,
    matched: { python: py.tags, javascript: js.tags },
  };
}

export function detectCodeLanguage(code: string): CodeLang {
  return scoreCodeLanguage(code).lang;
}

/** Il nodo giusto per un linguaggio riconosciuto. */
export const CODE_NODE_FOR_LANG: Readonly<Record<'python' | 'javascript', string>> = {
  python: 'action_run_python',
  javascript: 'action_run_js',
};

/** Il linguaggio che ciascun nodo code si aspetta nel campo `code`. */
export const LANG_FOR_CODE_NODE: ReadonlyMap<string, 'python' | 'javascript'> = new Map([
  ['action_run_python', 'python'],
  ['action_run_js', 'javascript'],
]);
