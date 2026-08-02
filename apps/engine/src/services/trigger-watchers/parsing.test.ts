/**
 * Caratterizzazione + bug-bounty — trigger-watchers/parsing.
 *
 * Pinna il comportamento ESATTO delle primitive estratte dal monolite
 * (split 2026-06-12) e copre le aree che nel monolite erano UNTESTED
 * (`safeRegex`, `pickAddress`, `collectAddresses` erano funzioni private).
 * Caccia i bug della classe "input ostile al confine del trigger":
 *   - prototype-pollution READ via JSON Pointer;
 *   - regex injection/typo che non deve crashare il poller;
 *   - normalizzazione/dedup dell'allowlist (case, separatori, JSON malformato);
 *   - indirizzi email malformati (entry senza address, gruppi vuoti).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AddressObject } from 'mailparser';
import {
  resolveJsonPointer,
  parseMarkSeen,
  parseAllowlist,
  safeRegex,
  pickAddress,
  collectAddresses,
} from './parsing.js';

describe('resolveJsonPointer — RFC 6901', () => {
  const doc = {
    type: 'trade',
    data: { price: 0, tags: ['a', 'b'], ok: false },
    'a/b': 1,
    'm~n': 2,
  };

  it('pointer vuoto → documento intero; valori falsy sono match validi', () => {
    expect(resolveJsonPointer(doc, '')).toBe(doc);
    expect(resolveJsonPointer(doc, '/data/price')).toBe(0); // 0 ≠ undefined
    expect(resolveJsonPointer(doc, '/data/ok')).toBe(false); // false ≠ undefined
  });

  it('token escaping ~1→/ e ~0→~ (ordine RFC corretto)', () => {
    expect(resolveJsonPointer(doc, '/a~1b')).toBe(1);
    expect(resolveJsonPointer(doc, '/m~0n')).toBe(2);
    // ~01 deve diventare ~1 (decodifica ~0 PRIMA non re-interpreta), non "/"
    expect(resolveJsonPointer({ '~1': 9 }, '/~01')).toBe(9);
  });

  it('array: solo indici interi in range', () => {
    expect(resolveJsonPointer(doc, '/data/tags/0')).toBe('a');
    expect(resolveJsonPointer(doc, '/data/tags/9')).toBeUndefined(); // out of range
    expect(resolveJsonPointer(doc, '/data/tags/-1')).toBeUndefined(); // negativo
    expect(resolveJsonPointer(doc, '/data/tags/1.5')).toBeUndefined(); // non intero
  });

  it('quirk Number() su indici array — CARATTERIZZATI (uno split futuro non deve cambiarli)', () => {
    // Number() coerce: questi sono i comportamenti REALI, pinnati apposta perché
    // un "miglioramento" inavvertito cambierebbe la semantica del filtro WS.
    expect(resolveJsonPointer(doc, '/data/tags/01')).toBe('b'); // Number('01')===1
    // token VUOTO (trailing slash): Number('')===0 ed è intero → indice 0.
    expect(resolveJsonPointer(doc, '/data/tags/')).toBe('a');
    // spazio: Number(' ')===0 → indice 0.
    expect(resolveJsonPointer(doc, '/data/tags/ ')).toBe('a');
  });

  it('pointer malformato (senza / iniziale) → undefined', () => {
    expect(resolveJsonPointer(doc, 'type')).toBeUndefined();
  });

  it('discesa in un primitivo o in null → undefined', () => {
    expect(resolveJsonPointer(doc, '/type/x')).toBeUndefined();
    expect(resolveJsonPointer({ a: null }, '/a/b')).toBeUndefined();
  });

  it('🚨 prototype-pollution READ: NON discende nella prototype chain', () => {
    // Oggetto literal: __proto__/constructor NON sono own-property → undefined.
    expect(resolveJsonPointer({}, '/__proto__')).toBeUndefined();
    expect(resolveJsonPointer({}, '/__proto__/polluted')).toBeUndefined();
    expect(resolveJsonPointer({}, '/constructor/prototype')).toBeUndefined();
    expect(resolveJsonPointer({ a: 1 }, '/toString')).toBeUndefined(); // metodo ereditato
  });

  it('🚨 un __proto__ OWN-property (da JSON.parse) è dato reale → letto in sicurezza', () => {
    // JSON.parse crea __proto__ come own data property (non inquina). Leggerlo è
    // safe (è solo dato), e il guard hasOwnProperty lo permette correttamente.
    const fromJson = JSON.parse('{"__proto__": {"x": 7}}') as unknown;
    expect(resolveJsonPointer(fromJson, '/__proto__/x')).toBe(7);
    // ...e NON ha inquinato Object.prototype.
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('parseMarkSeen', () => {
  it('modalità letterali valide', () => {
    expect(parseMarkSeen('on-success')).toBe('on-success');
    expect(parseMarkSeen('always')).toBe('always');
    expect(parseMarkSeen('never')).toBe('never');
  });
  it('legacy boolean true / "true" → always', () => {
    expect(parseMarkSeen(true)).toBe('always');
    expect(parseMarkSeen('true')).toBe('always');
  });
  it('🚨 default SICURO on-success per ogni input ignoto/falsy', () => {
    for (const v of [undefined, null, false, '', 'bogus', 42, {}, [], 'ALWAYS']) {
      expect(parseMarkSeen(v)).toBe('on-success');
    }
  });
});

describe('parseAllowlist', () => {
  it('JSON array string', () => {
    expect(parseAllowlist('["a@x.com","b@y.com"]')).toEqual(['a@x.com', 'b@y.com']);
  });
  it('separatori virgola / punto-e-virgola / newline', () => {
    expect(parseAllowlist('a@x.com, b@y.com;c@z.com\nd@w.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
      'd@w.com',
    ]);
  });
  it('string[] già parsato', () => {
    expect(parseAllowlist(['a@x.com', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com']);
  });
  it('🚨 dedup + lowercase + trim, e scarta i non-email (no @)', () => {
    expect(parseAllowlist(' A@X.com , a@x.com ,  notanemail , B@Y.com ')).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });
  it('🚨 JSON malformato che inizia con [ → token grezzo COL bracket (quirk caratterizzato)', () => {
    // Il fallback su JSON.parse fallito NON strippa il `[`: il token resta
    // '[a@x.com'. Innocuo (non matcherà mai un'email reale), ma è il comportamento
    // REALE → pinnato così lo split non lo cambia in silenzio. (Possibile
    // miglioria futura: strippare i bracket nel fallback — cambio SEMANTICO,
    // va fatto a parte con il suo test, non in un refactoring strutturale.)
    expect(parseAllowlist('[a@x.com')).toEqual(['[a@x.com']);
    expect(parseAllowlist('[bad json')).toEqual([]); // niente @ → scartato
  });
  it('array con elementi non-string → ignorati', () => {
    expect(parseAllowlist(['a@x.com', 42, null, { x: 1 }, 'b@y.com'])).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });
  it('forme non valide → []', () => {
    for (const v of [undefined, null, 42, {}, '', '   ', true]) {
      expect(parseAllowlist(v)).toEqual([]);
    }
  });
});

describe('safeRegex — hardening pattern operatore (RE2, anti-ReDoS)', () => {
  // NB: post-fix `safeRegex` ritorna un'istanza RE2 (motore lineare anti-ReDoS), NON un
  // RegExp di V8: `instanceof RegExp` è false e `.flags` è normalizzato (RE2 aggiunge 'u').
  // Quindi i test asseriscono il COMPORTAMENTO (match, case-sensitivity), non l'engine.
  it('pattern semplice → match case-SENSITIVE (nessun flag i)', () => {
    const r = safeRegex('foo.*bar');
    expect(r).not.toBeNull();
    expect(r!.test('fooXbar')).toBe(true);
    expect(r!.test('FOOXBAR')).toBe(false); // niente flag 'i' → case-sensitive
  });
  it('forma /pattern/flags → flag applicati (i = case-insensitive)', () => {
    const r = safeRegex('/hello/i');
    expect(r!.test('HELLO')).toBe(true); // 'i' attivo
  });
  it('🚨 pattern invalido → null (NON lancia) + warn loggato', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(safeRegex('(unclosed')).toBeNull();
    expect(safeRegex('[a-')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('"//" non matcha la forma /p/f (richiede ≥1 char) → regex letterale di "//"', () => {
    const r = safeRegex('//');
    expect(r).not.toBeNull();
    expect(r!.test('a//b')).toBe(true);
  });
  it('🚨 H2 anti-ReDoS: pattern evil su subject lungo NON blocca il poller (< 1s)', () => {
    // Il pattern è testato contro subject/sender di email IN ARRIVO (attacker-controlled).
    const r = safeRegex('(a+)+$');
    expect(r).not.toBeNull();
    const t0 = performance.now();
    const matched = r!.test('a'.repeat(80) + '!'); // forza backtracking massimo su V8
    const elapsed = performance.now() - t0;
    expect(matched).toBe(false);
    expect(elapsed).toBeLessThan(1000); // RE2 ~ms; col vecchio new RegExp sarebbe >3000ms
  });
  it('pattern con backreference (non-RE2) → null + warn, mai crash', async () => {
    const { logger } = await import('@/lib/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(safeRegex('(\\w)\\1')).toBeNull(); // RE2 rifiuta le backreference
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('pickAddress / collectAddresses', () => {
  const ao = (addrs: { address?: string }[]): AddressObject =>
    ({ value: addrs, html: '', text: '' }) as unknown as AddressObject;

  it('pickAddress: assente → "" (mai undefined)', () => {
    expect(pickAddress(undefined)).toBe('');
    expect(pickAddress(ao([]))).toBe('');
    expect(pickAddress(ao([{}]))).toBe(''); // entry senza address
  });
  it('pickAddress: primo indirizzo (oggetto o array)', () => {
    expect(pickAddress(ao([{ address: 'a@x.com' }, { address: 'b@y.com' }]))).toBe('a@x.com');
    expect(pickAddress([ao([{ address: 'first@x.com' }]), ao([{ address: 'second@x.com' }])])).toBe(
      'first@x.com',
    );
  });
  it('🚨 collectAddresses: appiattisce array e SCARTA le entry senza address', () => {
    const got = collectAddresses([
      ao([{ address: 'a@x.com' }, {}, { address: 'b@y.com' }]),
      ao([{ address: 'c@z.com' }]),
      ao([]), // gruppo vuoto
    ]);
    expect(got).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });
  it('collectAddresses: assente → []', () => {
    expect(collectAddresses(undefined)).toEqual([]);
  });
});

// FIX bug NaN/overflow (2026-06-12): clampNumber è la difesa unica contro
// config spazzatura nei poller — MAI NaN/Infinity in uscita.
describe('clampNumber', () => {
  it('valore valido in range → passa invariato', async () => {
    const { clampNumber } = await import('./parsing.js');
    expect(clampNumber('30', 2, 3600, 5)).toBe(30);
    expect(clampNumber(30, 2, 3600, 5)).toBe(30);
  });
  it('sotto il min → min; sopra il max → max', async () => {
    const { clampNumber } = await import('./parsing.js');
    expect(clampNumber('0', 2, 3600, 5)).toBe(2);
    expect(clampNumber('1e99', 2, 3600, 5)).toBe(3600);
  });
  it('spazzatura (stringa, NaN, ±Infinity, oggetto) → fallback, MAI NaN', async () => {
    const { clampNumber } = await import('./parsing.js');
    expect(clampNumber('abc', 2, 3600, 5)).toBe(5);
    expect(clampNumber(Number.NaN, 2, 3600, 5)).toBe(5);
    expect(clampNumber(Infinity, 2, 3600, 5)).toBe(5);
    expect(clampNumber(-Infinity, 2, 3600, 5)).toBe(5);
    expect(clampNumber({}, 2, 3600, 5)).toBe(5);
  });
  it('undefined/null → fallback (config assente)', async () => {
    const { clampNumber } = await import('./parsing.js');
    expect(clampNumber(undefined, 2, 3600, 5)).toBe(5);
    expect(clampNumber(null, 2, 3600, 5)).toBe(5);
  });
  it('stringa vuota → 0 → clampata al min (comportamento storico Number("")=0 preservato)', async () => {
    const { clampNumber } = await import('./parsing.js');
    expect(clampNumber('', 2, 3600, 5)).toBe(2);
  });
});
