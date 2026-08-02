/**
 * Behavioral test — convertNode (logic_convert) executor reale.
 *
 * Esegue convertExecutor con input reali (JSON ↔ CSV ↔ text). Obiettivo:
 * scovare bug, non confermare il felice percorso.
 *
 * FIX applicati (bug trovati dai test → codice corretto):
 *  - toCsv: header = UNIONE delle chiavi di tutte le righe (prima usava solo la
 *    prima riga → perdita colonne su oggetti eterogenei)
 *  - parseCsv: tokenizer RFC 4180 vero (gestisce virgole, newline e "" dentro i
 *    campi quotati). Prima era uno split naïve su ',' che corrompeva i campi quotati.
 */
import { describe, it, expect } from 'vitest';
import { convertNode } from './transform.js';
import type { NodeExecutionContext } from '../types.js';

const ctx = {
  tenantId: 't1',
  workflowId: 'wf1',
  runId: 'r1',
  nodeId: 'n1',
  secrets: {},
} as unknown as NodeExecutionContext;

async function convert(config: Record<string, unknown>, input: unknown): Promise<unknown> {
  const exec = convertNode.executor;
  if (!exec) throw new Error('convertNode senza executor');
  const res = await exec(config, input, ctx);
  return res.output;
}

describe('convert — JSON ↔ CSV', () => {
  it('json→csv: array di oggetti → header + righe', async () => {
    const out = await convert({ from: 'json', to: 'csv' }, [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
    expect(out).toBe('name,age\nAlice,30\nBob,25');
  });

  it('json→csv: escaping RFC4180 di virgola, virgolette e newline nei valori', async () => {
    const out = await convert({ from: 'json', to: 'csv' }, [
      { a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' },
    ]);
    expect(out).toBe('a,b,c\n"x,y","he said ""hi""","line1\nline2"');
  });

  it("FIX: json→csv con oggetti ETEROGENEI include l'unione delle colonne (no perdita dati)", async () => {
    const out = (await convert({ from: 'json', to: 'csv' }, [
      { name: 'Alice', age: 30 },
      { name: 'Bob', city: 'Milan' }, // 'city' assente nella prima riga
    ])) as string;
    const [header, row1, row2] = out.split('\n');
    expect(header).toBe('name,age,city'); // unione, non solo le chiavi della prima riga
    expect(row1).toBe('Alice,30,'); // 'city' mancante → vuoto
    expect(row2).toBe('Bob,,Milan'); // 'age' mancante → vuoto, 'city' presente
  });

  it('csv→json: CSV semplice → array di oggetti (trim celle)', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'name, age\nAlice, 30\nBob, 25');
    expect(out).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  it('csv→json: righe vuote ignorate', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'a,b\n1,2\n\n3,4\n');
    expect(out).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('FIX RFC4180: virgola dentro campo quotato NON spezza la colonna', async () => {
    const out = await convert(
      { from: 'csv', to: 'json' },
      '"cognome, nome",eta\n"Rossi, Mario",40',
    );
    expect(out).toEqual([{ 'cognome, nome': 'Rossi, Mario', eta: '40' }]);
  });

  it('FIX RFC4180: virgolette escapate "" dentro campo quotato', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'q\n"he said ""hi"""');
    expect(out).toEqual([{ q: 'he said "hi"' }]);
  });

  it('FIX RFC4180: newline dentro campo quotato non spezza la riga', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'a,b\n"riga1\nriga2",x');
    expect(out).toEqual([{ a: 'riga1\nriga2', b: 'x' }]);
  });

  it('FIX RFC4180: campo QUOTATO preserva gli spazi, il non-quotato viene trimmato', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'a,b\n"  spazi  ",  trim  ');
    expect(out).toEqual([{ a: '  spazi  ', b: 'trim' }]);
  });

  it('round-trip json→csv→json preserva valori con virgole', async () => {
    const csv = (await convert({ from: 'json', to: 'csv' }, [{ name: 'a,b', v: '1' }])) as string;
    const back = await convert({ from: 'csv', to: 'json' }, csv);
    expect(back).toEqual([{ name: 'a,b', v: '1' }]);
  });
});

describe('convert — 🚨 SECURITY: CSV formula injection (CWE-1236)', () => {
  // logic_convert era l'UNICO percorso di generazione CSV senza la guardia anti-formula
  // (action_csv ce l'aveva). Questi test bloccano la regressione su entrambi i lati.
  // Round-trip json→csv→json: riestrae il valore di cella indipendentemente dal
  // quoting RFC, così l'assert è robusto anche con payload contenenti virgolette.
  it.each(['=HYPERLINK("http://evil")', '+1+1', '-cmd', '@SUM(A1)', '\t=1+1'])(
    'cella stringa formula %j → prefissata con apice (CWE-1236)',
    async (payload) => {
      const csv = (await convert({ from: 'json', to: 'csv' }, [{ nome: payload }])) as string;
      const back = (await convert({ from: 'csv', to: 'json' }, csv)) as { nome: string }[];
      // MUTATION: senza neutralizeCsvFormula il valore resterebbe "=HYPERLINK(...)" attivo → rosso.
      expect(back[0]?.nome).toBe(`'${payload}`);
    },
  );

  it('🚨 anche le INTESTAZIONI con trigger di formula sono neutralizzate', async () => {
    const out = (await convert({ from: 'json', to: 'csv' }, [{ '=danger': 'v' }])) as string;
    const header = out.split('\n')[0] ?? '';
    expect(header.startsWith("'=danger")).toBe(true);
  });

  it('i valori NUMERICI non vengono toccati (no "\'30")', async () => {
    const out = (await convert({ from: 'json', to: 'csv' }, [{ n: 30, neg: -5 }])) as string;
    // numeri serializzati via JSON.stringify → "30", "-5", MAI apicizzati
    expect(out).toBe('n,neg\n30,-5');
  });

  it('una stringa con \\r viene quotata (RFC 4180) — prima il \\r non era nel set di quoting', async () => {
    const out = (await convert({ from: 'json', to: 'csv' }, [{ a: 'x\ry' }])) as string;
    expect(out).toBe('a\n"x\ry"');
  });
});

describe('convert — delimitatore configurabile + auto-detect', () => {
  it('CSV→JSON con delimiter ";" esplicito', async () => {
    const out = await convert({ from: 'csv', to: 'json', delimiter: ';' }, 'nome;eta\nAlice;30');
    expect(out).toEqual([{ nome: 'Alice', eta: '30' }]);
  });
  it('CSV→JSON auto-detect del ";" (gestionali IT)', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'a;b;c\n1;2;3');
    expect(out).toEqual([{ a: '1', b: '2', c: '3' }]);
  });
  it('CSV→JSON auto-detect del TAB (TSV)', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'a\tb\n1\t2');
    expect(out).toEqual([{ a: '1', b: '2' }]);
  });
  it('🚨 auto-detect NON conta i delimitatori dentro i campi quotati', async () => {
    // La prima riga ha 1 virgola reale e ";" solo dentro le virgolette → vince la virgola.
    const out = (await convert({ from: 'csv', to: 'json' }, '"a;b",c\n1,2')) as Record<
      string,
      string
    >[];
    expect(Object.keys(out[0]!)).toEqual(['a;b', 'c']);
  });
  it('JSON→CSV con delimiter ";" e quoting del ";" nei valori', async () => {
    const out = await convert({ from: 'json', to: 'csv', delimiter: ';' }, [{ a: 'x;y', b: 'z' }]);
    expect(out).toBe('a;b\n"x;y";z');
  });
  it('round-trip json→csv→json con ";" preserva i valori che contengono ";"', async () => {
    const csv = (await convert({ from: 'json', to: 'csv', delimiter: ';' }, [
      { v: 'a;b' },
    ])) as string;
    const back = await convert({ from: 'csv', to: 'json', delimiter: ';' }, csv);
    expect(back).toEqual([{ v: 'a;b' }]);
  });
});

describe('convert — CSV→JSON coercion tipi (OPT-IN)', () => {
  it('🚨 MUTATION default OFF: i numeri restano STRINGHE (no breaking dei workflow esistenti)', async () => {
    const out = await convert({ from: 'csv', to: 'json' }, 'n,v\n42,3.5');
    expect(out).toEqual([{ n: '42', v: '3.5' }]);
  });
  it('parseNumbers ON: celle numeriche → number (EN)', async () => {
    const out = await convert({ from: 'csv', to: 'json', parseNumbers: true }, 'n,v\n42,3.5');
    expect(out).toEqual([{ n: 42, v: 3.5 }]);
  });
  it('parseNumbers ON: formato italiano "1.234,56" → 1234.56', async () => {
    const out = await convert({ from: 'csv', to: 'json', parseNumbers: true }, 'imp\n"1.234,56"');
    expect(out).toEqual([{ imp: 1234.56 }]);
  });
  it('parseNumbers ON: le celle NON numeriche restano stringa, la cella vuota resta ""', async () => {
    const out = await convert({ from: 'csv', to: 'json', parseNumbers: true }, 'a,b,c\nciao,,42');
    expect(out).toEqual([{ a: 'ciao', b: '', c: 42 }]);
  });
  it('parseBooleans ON: "true"/"false" (case-insensitive) → boolean, gli altri invariati', async () => {
    const out = await convert(
      { from: 'csv', to: 'json', parseBooleans: true },
      'f\nTrue\nFALSE\nmaybe',
    );
    expect(out).toEqual([{ f: true }, { f: false }, { f: 'maybe' }]);
  });
  it('parseNumbers ON ma "00184" CAP → resta numero? no: lo zero iniziale NON deve perdersi su un codice', async () => {
    // Number("00184") = 184: se l'utente attiva parseNumbers accetta questa semantica (è un opt-in),
    // ma documentiamo il comportamento con un test esplicito anti-sorpresa.
    const out = (await convert({ from: 'csv', to: 'json', parseNumbers: true }, 'cap\n00184')) as {
      cap: unknown;
    }[];
    expect(out[0]!.cap).toBe(184);
  });
});

describe('convert — JSON ↔ text', () => {
  it('json→text: oggetto → JSON pretty 2-spazi', async () => {
    const out = await convert({ from: 'json', to: 'text' }, { x: 1 });
    expect(out).toBe('{\n  "x": 1\n}');
  });

  it('text→json: stringa rimane stringa (parsed=String(input))', async () => {
    const out = await convert({ from: 'text', to: 'json' }, 'hello');
    expect(out).toBe('hello');
  });

  it('json input come STRINGA viene parsato', async () => {
    const out = await convert({ from: 'json', to: 'text' }, '{"a":1}');
    expect(out).toBe('{\n  "a": 1\n}');
  });
});

describe('convert — edge & contratto', () => {
  it('default from/to = json quando config mancante (passthrough oggetto)', async () => {
    const out = await convert({}, { keep: true });
    expect(out).toEqual({ keep: true });
  });

  it('json→csv di NON-array → stringa vuota (contratto: csv richiede un array)', async () => {
    const out = await convert({ from: 'json', to: 'csv' }, { single: 'object' });
    expect(out).toBe('');
  });

  it("json input stringa malformata → l'executor propaga (engine gestisce il fallimento)", async () => {
    await expect(convert({ from: 'json', to: 'json' }, '{invalid')).rejects.toThrow();
  });

  it('result include durationMs numerico', async () => {
    const exec = convertNode.executor!;
    const res = await exec({ from: 'json', to: 'json' }, { a: 1 }, ctx);
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });
});
