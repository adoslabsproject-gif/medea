/**
 * code-lang detector — test 2026-grade, adversariali.
 *
 * Obiettivo: stanare bug del classificatore. Non basta "python è python":
 * verifichiamo i CONFINI (frammenti ambigui che NON devono switchare),
 * il caso REALE che ha rotto il workflow utente, e i falsi-positivi
 * potenziali (codice valido in entrambi i linguaggi).
 */
import { describe, it, expect } from 'vitest';
import {
  detectCodeLanguage,
  scoreCodeLanguage,
  CODE_NODE_FOR_LANG,
  LANG_FOR_CODE_NODE,
} from './code-lang.js';

describe('detectCodeLanguage — caso reale user 2026-06-09', () => {
  it('classifica come python il template Python incollato in un nodo run_js', () => {
    // Esattamente il codice generato da Liara nel bug report.
    const code = [
      'import json, os',
      '',
      'data = json.loads(os.environ.get("MEDEA_INPUT", "{}"))',
      'print({"received_keys": list(data.keys()), "count": len(data)})',
    ].join('\n');
    const s = scoreCodeLanguage(code);
    expect(s.lang).toBe('python');
    // Deve aver visto MOLTEPLICI segnali forti (non un singolo match fragile).
    expect(s.pythonScore).toBeGreaterThanOrEqual(6);
    expect(s.javascriptScore).toBe(0);
    expect(s.matched.python).toContain('py-import');
    expect(s.matched.python).toContain('py-json-loads');
    expect(s.matched.python).toContain('py-print');
  });

  it('classifica come javascript il template di default di action_run_js', () => {
    const code = [
      '// input = output del nodo precedente',
      'const items = input.items || [];',
      'const total = items.reduce((s, x) => s + (x.amount || 0), 0);',
      'return { total, count: items.length };',
    ].join('\n');
    const s = scoreCodeLanguage(code);
    expect(s.lang).toBe('javascript');
    expect(s.javascriptScore).toBeGreaterThanOrEqual(6); // const×1(3) + arrow(3) ...
    expect(s.pythonScore).toBe(0);
    expect(s.matched.javascript).toContain('js-decl');
    expect(s.matched.javascript).toContain('js-arrow');
  });
});

describe('detectCodeLanguage — segnali python esclusivi', () => {
  it.each([
    ['from datetime import datetime\nx = datetime.now()', 'py-from-import'],
    ['def compute(a, b):\n    return a + b', 'py-def'],
    ['if x > 3:\n    y = 1\nelif x < 0:\n    y = 2', 'py-elif'],
    ['name = "ada"\ngreeting = f"ciao {name}"', 'py-fstring-dq'],
    // py-const (weight 1) da solo è ambiguo by-design: lo accompagniamo a un
    // blocco python forte così python vince E il tag py-const è presente.
    ['data = {"ok": True}\nfor k in data:\n    print(k)', 'py-const'],
    ['for i in range(10):\n    print(i)', 'py-block-colon'],
  ])('rileva python da %j', (code, expectedTag) => {
    const s = scoreCodeLanguage(code);
    expect(s.lang).toBe('python');
    expect(s.matched.python).toContain(expectedTag);
  });
});

describe('detectCodeLanguage — segnali javascript esclusivi', () => {
  it.each([
    ['let total = 0;\ntotal = total + 1;', 'js-decl'],
    ['const f = (x) => x * 2;', 'js-arrow'],
    ['function add(a, b) { return a + b; }', 'js-function'],
    ['if (a === b || c !== d) { return 1; }', 'js-strict-eq'],
    ['const o = JSON.parse(input);\nconsole.log(o);', 'js-json'],
    ['const url = `https://x/${id}`;', 'js-template-literal'],
  ])('rileva javascript da %j', (code, expectedTag) => {
    const s = scoreCodeLanguage(code);
    expect(s.lang).toBe('javascript');
    expect(s.matched.javascript).toContain(expectedTag);
  });
});

describe('detectCodeLanguage — AMBIGUO: NON deve switchare (anti falso-positivo)', () => {
  it.each([
    // Espressione aritmetica valida in entrambi.
    'x = 1 + 2',
    // Assegnazione + accesso proprietà — valido in entrambi (no decl keyword).
    'result = input.value',
    // Stringa pura.
    '"just a string"',
    // Commento generico (// è JS, ma da solo non decide; # sarebbe py ma idem).
    'return 42',
    // Vuoto / whitespace.
    '',
    '   \n  \t ',
  ])('ritorna ambiguous per %j', (code) => {
    expect(detectCodeLanguage(code)).toBe('ambiguous');
  });

  it('un singolo "None"/"undefined" debole NON basta a decidere (richiede DECISIVE=2)', () => {
    // Solo un segnale debole (weight 1) → resta ambiguo.
    expect(scoreCodeLanguage('value = None').lang).toBe('ambiguous');
    expect(scoreCodeLanguage('value = undefined').lang).toBe('ambiguous');
  });
});

describe('detectCodeLanguage — codice MISTO (deve vincere il linguaggio dominante)', () => {
  it('python con una parola JS-like sparsa resta python', () => {
    // "null" appare come stringa ma i segnali python dominano nettamente.
    const code = 'import os\ndef f():\n    print("null")\n    return None';
    const s = scoreCodeLanguage(code);
    expect(s.lang).toBe('python');
    expect(s.pythonScore).toBeGreaterThan(s.javascriptScore);
  });

  it('js con la parola "print" dentro una stringa resta javascript', () => {
    const code = 'const label = "print(x)";\nconst y = (a) => a;\nreturn label;';
    const s = scoreCodeLanguage(code);
    // "print(" dentro stringa fa +2 python, ma const+arrow fanno +6 js → js vince.
    expect(s.lang).toBe('javascript');
    expect(s.javascriptScore).toBeGreaterThan(s.pythonScore);
  });
});

describe('detectCodeLanguage — distinzione import python vs import ES', () => {
  it('"import json, os" è python (no from+stringa)', () => {
    expect(detectCodeLanguage('import json, os')).toBe('python');
  });
  it('"import x from \'y\'" è javascript (ha from+stringa)', () => {
    const s = scoreCodeLanguage("import foo from 'bar';\nconst z = foo();");
    expect(s.lang).toBe('javascript');
    expect(s.matched.javascript).toContain('js-es-import');
    // Non deve ALSO matchare il pattern python py-import (che richiede no 'from').
    expect(s.matched.python).not.toContain('py-import');
  });
});

describe('mapping defId ↔ linguaggio', () => {
  it('CODE_NODE_FOR_LANG mappa correttamente', () => {
    expect(CODE_NODE_FOR_LANG.python).toBe('action_run_python');
    expect(CODE_NODE_FOR_LANG.javascript).toBe('action_run_js');
  });
  it("LANG_FOR_CODE_NODE è l'inverso esatto", () => {
    expect(LANG_FOR_CODE_NODE.get('action_run_python')).toBe('python');
    expect(LANG_FOR_CODE_NODE.get('action_run_js')).toBe('javascript');
    expect(LANG_FOR_CODE_NODE.has('action_http')).toBe(false);
  });
  it('round-trip coerente: per ogni lang, CODE_NODE_FOR_LANG→LANG_FOR_CODE_NODE è identità', () => {
    for (const lang of ['python', 'javascript'] as const) {
      const defId = CODE_NODE_FOR_LANG[lang];
      expect(LANG_FOR_CODE_NODE.get(defId)).toBe(lang);
    }
  });
});

describe('robustezza input', () => {
  it('non lancia su input non-stringa (difensivo)', () => {
    // @ts-expect-error test runtime hardening
    expect(() => scoreCodeLanguage(null)).not.toThrow();
    // @ts-expect-error test runtime hardening
    expect(scoreCodeLanguage(undefined).lang).toBe('ambiguous');
  });
  it('è deterministico (stesso input → stesso output)', () => {
    const code = 'import json\nprint(json.dumps({}))';
    expect(scoreCodeLanguage(code)).toEqual(scoreCodeLanguage(code));
  });
});
