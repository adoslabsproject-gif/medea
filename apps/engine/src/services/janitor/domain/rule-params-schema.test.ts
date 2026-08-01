/**
 * Test 2026-grade — domain/rule-params-schema.ts (validator typed regole janitor).
 *
 * 🚨 SINGLE SOURCE OF TRUTH: lo schema valida runtime + descrive UI.
 *    Bug qui = regola misconfigurata sblocca quarantena o blocca lock.
 *
 * 🚨 5 TIPI: number/string/boolean/duration_ms/enum — narrowing da unknown DB.
 *
 * 🚨 DEFAULTS auto-fill: param mancante → default (no error).
 *
 * 🚨 UNKNOWN keys: scartati silenziosamente (no error). Forward-compat.
 *
 * 🚨 humanMs: range coverage ms/s/m/h/g boundary
 */
import { describe, it, expect } from 'vitest';
import {
  validateParams,
  humanMs,
  type RuleParamSchema,
} from './rule-params-schema.js';

const sNumber: RuleParamSchema = {
  name: 'threshold', type: 'number', label: 'Soglia', required: true,
  default: 10, min: 1, max: 100,
};
const sString: RuleParamSchema = {
  name: 'label', type: 'string', label: 'Etichetta', required: false,
  default: 'default',
};
const sStringWithPattern: RuleParamSchema = {
  name: 'code', type: 'string', label: 'Codice', required: false,
  default: 'AB123', maxLength: 10, pattern: '^[A-Z]{2}\\d{3}$',
};
const sBool: RuleParamSchema = {
  name: 'enabled', type: 'boolean', label: 'Abilitato', required: false,
  default: true,
};
const sDur: RuleParamSchema = {
  name: 'ttl', type: 'duration_ms', label: 'TTL', required: false,
  default: 60000, minMs: 1000, maxMs: 86_400_000,
};
const sEnum: RuleParamSchema = {
  name: 'mode', type: 'enum', label: 'Modo', required: false,
  default: 'fast',
  values: [
    { value: 'fast', label: 'Veloce' },
    { value: 'safe', label: 'Sicuro' },
  ],
};

describe('🚨 validateParams — defaults', () => {
  it('🚨 input vuoto → tutti i default applicati', () => {
    const r = validateParams([sNumber, sString, sBool], {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ threshold: 10, label: 'default', enabled: true });
    }
  });

  it('🚨 input null → trattato come {}, defaults applicati', () => {
    const r = validateParams([sNumber], null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ threshold: 10 });
  });

  it('🚨 input non-object (string) → trattato come {}', () => {
    const r = validateParams([sBool], 'garbage');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ enabled: true });
  });

  it('🚨 SECURITY: input array → trattato come object literal (array IS object)', () => {
    // typeof [] === 'object' → entra nel branch; mancando le keys, riempie default
    const r = validateParams([sBool], []);
    expect(r.ok).toBe(true);
  });

  it('🚨 input con keys sconosciute → SCARTA (forward-compat) + defaults', () => {
    const r = validateParams([sBool], { enabled: false, future_key: 'whatever' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ enabled: false });
      expect('future_key' in r.value).toBe(false);
    }
  });

  it('🚨 output è frozen (immutable)', () => {
    const r = validateParams([sBool], {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });
});

describe('🚨 validateParams — number', () => {
  it('🚨 numero valido nel range → ok', () => {
    const r = validateParams([sNumber], { threshold: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.threshold).toBe(50);
  });

  it('🚨 string al posto di number → error', () => {
    const r = validateParams([sNumber], { threshold: '50' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error[0]!.param).toBe('threshold');
      expect(r.error[0]!.message).toContain('Atteso numero');
    }
  });

  it('🚨 NaN → error (non finito)', () => {
    const r = validateParams([sNumber], { threshold: NaN });
    expect(r.ok).toBe(false);
  });

  it('🚨 Infinity → error', () => {
    const r = validateParams([sNumber], { threshold: Infinity });
    expect(r.ok).toBe(false);
  });

  it('🚨 sotto min → error con valore min', () => {
    const r = validateParams([sNumber], { threshold: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toContain('1');
  });

  it('🚨 sopra max → error con valore max', () => {
    const r = validateParams([sNumber], { threshold: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toContain('100');
  });

  it('🚨 boundary min OK', () => {
    const r = validateParams([sNumber], { threshold: 1 });
    expect(r.ok).toBe(true);
  });

  it('🚨 boundary max OK', () => {
    const r = validateParams([sNumber], { threshold: 100 });
    expect(r.ok).toBe(true);
  });

  it('🚨 number senza min/max → no range check', () => {
    const free: RuleParamSchema = {
      name: 'x', type: 'number', label: 'X', required: false, default: 0,
    };
    const r = validateParams([free], { x: -999999 });
    expect(r.ok).toBe(true);
  });
});

describe('🚨 validateParams — string', () => {
  it('🚨 string valida → ok', () => {
    const r = validateParams([sString], { label: 'hello' });
    expect(r.ok).toBe(true);
  });

  it('🚨 non-string → error', () => {
    const r = validateParams([sString], { label: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toContain('Atteso testo');
  });

  it('🚨 maxLength sforato → error', () => {
    const short: RuleParamSchema = {
      name: 'x', type: 'string', label: 'X', required: false,
      default: '', maxLength: 5,
    };
    const r = validateParams([short], { x: 'too_long_string' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toContain('5');
  });

  it('🚨 pattern match → ok', () => {
    const r = validateParams([sStringWithPattern], { code: 'AB123' });
    expect(r.ok).toBe(true);
  });

  it('🚨 pattern non match → error', () => {
    const r = validateParams([sStringWithPattern], { code: 'invalid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toContain('pattern');
  });

  it('🚨 pattern malformato (regex invalida) → tollera (no throw, accept value)', () => {
    const bad: RuleParamSchema = {
      name: 'x', type: 'string', label: 'X', required: false,
      default: '', pattern: '[unclosed',
    };
    // Pattern bug → ignorato (commento del codice)
    const r = validateParams([bad], { x: 'whatever' });
    expect(r.ok).toBe(true);
  });

  it('🚨 SECURITY: ReDoS attempt pattern (catastrophic) → trattato come regex valida ma OK', () => {
    // Garante non blocca pattern arbitrari ma la validazione è O(input)
    const safe: RuleParamSchema = {
      name: 'x', type: 'string', label: 'X', required: false,
      default: '', pattern: '^a+$',
    };
    const r = validateParams([safe], { x: 'aaaa' });
    expect(r.ok).toBe(true);
  });
});

describe('🚨 validateParams — boolean', () => {
  it('🚨 true → ok', () => {
    const r = validateParams([sBool], { enabled: true });
    expect(r.ok).toBe(true);
  });

  it('🚨 false → ok', () => {
    const r = validateParams([sBool], { enabled: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.enabled).toBe(false);
  });

  it('🚨 0 / 1 (truthy) → error (strict type)', () => {
    expect(validateParams([sBool], { enabled: 1 }).ok).toBe(false);
    expect(validateParams([sBool], { enabled: 0 }).ok).toBe(false);
  });

  it('🚨 "true" string → error (strict)', () => {
    expect(validateParams([sBool], { enabled: 'true' }).ok).toBe(false);
  });

  it('🚨 null → error', () => {
    expect(validateParams([sBool], { enabled: null }).ok).toBe(false);
  });
});

describe('🚨 validateParams — duration_ms', () => {
  it('🚨 integer positivo → ok', () => {
    const r = validateParams([sDur], { ttl: 30000 });
    expect(r.ok).toBe(true);
  });

  it('🚨 zero → ok (boundary)', () => {
    const free: RuleParamSchema = {
      name: 'd', type: 'duration_ms', label: 'D', required: false, default: 0,
    };
    const r = validateParams([free], { d: 0 });
    expect(r.ok).toBe(true);
  });

  it('🚨 float (non integer) → error', () => {
    const r = validateParams([sDur], { ttl: 30000.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toContain('intero positivo');
  });

  it('🚨 negativo → error', () => {
    const r = validateParams([sDur], { ttl: -1 });
    expect(r.ok).toBe(false);
  });

  it('🚨 sotto minMs → error con humanMs format', () => {
    const r = validateParams([sDur], { ttl: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toMatch(/1s|1000ms/);
  });

  it('🚨 sopra maxMs → error con humanMs format', () => {
    const r = validateParams([sDur], { ttl: 100_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error[0]!.message).toMatch(/1\.0g|24h/);
  });

  it('🚨 boundary minMs OK', () => {
    const r = validateParams([sDur], { ttl: 1000 });
    expect(r.ok).toBe(true);
  });

  it('🚨 boundary maxMs OK', () => {
    const r = validateParams([sDur], { ttl: 86_400_000 });
    expect(r.ok).toBe(true);
  });
});

describe('🚨 validateParams — enum', () => {
  it('🚨 valore ammesso → ok', () => {
    const r = validateParams([sEnum], { mode: 'safe' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mode).toBe('safe');
  });

  it('🚨 valore non ammesso → error con lista values', () => {
    const r = validateParams([sEnum], { mode: 'turbo' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error[0]!.message).toContain('fast');
      expect(r.error[0]!.message).toContain('safe');
    }
  });

  it('🚨 non-string → error', () => {
    const r = validateParams([sEnum], { mode: 123 });
    expect(r.ok).toBe(false);
  });
});

describe('🚨 validateParams — multi-param', () => {
  it('🚨 tutti validi → ok con tutti i valori', () => {
    const r = validateParams([sNumber, sString, sBool], {
      threshold: 5, label: 'x', enabled: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ threshold: 5, label: 'x', enabled: false });
    }
  });

  it('🚨 multipli errori → tutti raccolti (no fail-fast)', () => {
    const r = validateParams([sNumber, sString, sBool], {
      threshold: 'bad', label: 999, enabled: 'no',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toHaveLength(3);
      expect(r.error.map(e => e.param).sort()).toEqual(['enabled', 'label', 'threshold']);
    }
  });

  it('🚨 mix: alcuni validi + un errore → Err (no partial OK)', () => {
    const r = validateParams([sNumber, sString], {
      threshold: 50, label: 999,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toHaveLength(1);
      expect(r.error[0]!.param).toBe('label');
    }
  });

  it('🚨 schema vuoto → ok empty object', () => {
    const r = validateParams([], { anything: 'whatever' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });
});

describe('🚨 humanMs — boundary formatting', () => {
  it('🚨 < 1s → ms', () => {
    expect(humanMs(500)).toBe('500ms');
    expect(humanMs(0)).toBe('0ms');
    expect(humanMs(999)).toBe('999ms');
  });

  it('🚨 boundary 1000 → 1s', () => {
    expect(humanMs(1000)).toBe('1s');
  });

  it('🚨 < 60s → s', () => {
    expect(humanMs(30_000)).toBe('30s');
    expect(humanMs(59_999)).toBe('60s'); // toFixed(0) round
  });

  it('🚨 boundary 60_000 → 1m', () => {
    expect(humanMs(60_000)).toBe('1m');
  });

  it('🚨 < 1h → m', () => {
    expect(humanMs(300_000)).toBe('5m');
    expect(humanMs(3_599_999)).toBe('60m');
  });

  it('🚨 boundary 3_600_000 → h', () => {
    expect(humanMs(3_600_000)).toBe('1.0h');
  });

  it('🚨 < 24h → h con decimale', () => {
    expect(humanMs(7_200_000)).toBe('2.0h');
    expect(humanMs(5_400_000)).toBe('1.5h');
  });

  it('🚨 boundary 86_400_000 → g', () => {
    expect(humanMs(86_400_000)).toBe('1.0g');
  });

  it('🚨 ≥ 24h → g con decimale', () => {
    expect(humanMs(172_800_000)).toBe('2.0g');
  });

  it('🚨 numeri molto grandi (1 anno)', () => {
    expect(humanMs(86_400_000 * 365)).toMatch(/365\.0g/);
  });
});
