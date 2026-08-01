import { describe, it, expect } from 'vitest';
import { safeUserRegex, UnsafeRegexError, MAX_USER_REGEX_PATTERN_LENGTH } from './safe-user-regex.js';

describe('safeUserRegex', () => {
  describe('drop-in RegExp compatibility', () => {
    it('compila un pattern valido ed è usabile con .test', () => {
      expect(safeUserRegex('\\d+').test('abc123')).toBe(true);
      expect(safeUserRegex('^foo$').test('bar')).toBe(false);
    });

    it('funziona con String.prototype.replace (global)', () => {
      const out = 'hello world'.replace(safeUserRegex('o', 'g'), '0');
      expect(out).toBe('hell0 w0rld');
    });

    it('funziona con .exec + lastIndex su flag global', () => {
      const re = safeUserRegex('\\d+', 'g');
      const found: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec('a1b22c333')) !== null) {
        found.push(m[0]);
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
      expect(found).toEqual(['1', '22', '333']);
    });

    it('cattura i gruppi come RegExp nativo', () => {
      const m = safeUserRegex('(\\w+)@(\\w+)').exec('user@host');
      expect(m?.[1]).toBe('user');
      expect(m?.[2]).toBe('host');
    });
  });

  describe('ANTI-ReDoS (la ragion d\'essere del guard)', () => {
    // Pattern "evil": catastrophic backtracking su RegExp V8 (secondi/minuti).
    // Con RE2 (automa, tempo lineare) deve completare in millisecondi.
    // MUTATION: se safeUserRegex tornasse a `new RegExp`, questo test va in
    // timeout (ReDoS) → rosso. È la prova che il fix è reale, non cosmetico.
    it('pattern (a+)+$ su input lungo completa in tempo lineare (no ReDoS)', () => {
      const re = safeUserRegex('(a+)+$');
      const evilInput = 'a'.repeat(60) + 'X';
      const start = Date.now();
      const result = re.test(evilInput);
      const elapsed = Date.now() - start;
      expect(result).toBe(false);
      expect(elapsed).toBeLessThan(500); // RE2 reale: ~0ms; V8 RegExp: >>secondi
    });

    it('pattern nested (a|aa)+ su input non-matchante è lineare', () => {
      const re = safeUserRegex('^(a|aa)+$');
      const start = Date.now();
      re.test('a'.repeat(50) + 'b');
      expect(Date.now() - start).toBeLessThan(500);
    });
  });

  describe('rifiuto esplicito (mai silent-break, mai fallback vulnerabile)', () => {
    it('rifiuta pattern con backreference (richiede backtracking)', () => {
      expect(() => safeUserRegex('(\\w)\\1')).toThrow(UnsafeRegexError);
    });

    it('rifiuta pattern con lookbehind', () => {
      expect(() => safeUserRegex('(?<=x)y')).toThrow(UnsafeRegexError);
    });

    it('rifiuta pattern con lookahead', () => {
      expect(() => safeUserRegex('foo(?=bar)')).toThrow(UnsafeRegexError);
    });

    it('rifiuta pattern sintatticamente invalido', () => {
      expect(() => safeUserRegex('(')).toThrow(UnsafeRegexError);
    });

    it('rifiuta pattern oltre la lunghezza massima', () => {
      const tooLong = 'a'.repeat(MAX_USER_REGEX_PATTERN_LENGTH + 1);
      expect(() => safeUserRegex(tooLong)).toThrow(UnsafeRegexError);
    });

    it('accetta pattern esattamente alla lunghezza massima', () => {
      const atLimit = 'a'.repeat(MAX_USER_REGEX_PATTERN_LENGTH);
      expect(() => safeUserRegex(atLimit)).not.toThrow();
    });

    it('rifiuta input non-stringa (bug-bounty: cast forzato)', () => {
      // @ts-expect-error — verifica la guardia runtime su input non tipizzato
      expect(() => safeUserRegex(null)).toThrow(UnsafeRegexError);
      // @ts-expect-error — idem per number
      expect(() => safeUserRegex(123)).toThrow(UnsafeRegexError);
    });

    it('UnsafeRegexError ha name stabile e messaggio esplicativo', () => {
      try {
        safeUserRegex('(?<=x)y');
        expect.unreachable('doveva lanciare');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsafeRegexError);
        expect((err as UnsafeRegexError).name).toBe('UnsafeRegexError');
        expect((err as UnsafeRegexError).message).toMatch(/RE2|backtracking|ReDoS/i);
      }
    });
  });
});
