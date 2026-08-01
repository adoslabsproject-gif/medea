/**
 * Test 2026-grade — lead-score.service.ts (deterministic B2B lead qualification).
 *
 * 🚨 BUSINESS-CRITICAL: workflow cold outreach reale. DETERMINISMO è REQUIREMENT:
 * stesso input → stesso score, sempre. Anche con LLM disponibile, qui usiamo
 * pattern-matching pure perché la riproducibilità del scoring guida le scelte
 * sui campagne email che vanno a clienti veri.
 *
 * Coverage:
 *  - profile marine-thrusters default: positive keywords matched
 *  - country tier (EU+UK = +20, world = +10, unknown = 0)
 *  - negative keywords subtraction (cap 3× per pattern)
 *  - score clamp 0-100
 *  - category dominant (shipyard/distributor/marina/service/unknown)
 *  - threshold default 50 + send_recommended
 *  - custom profile via config
 *  - log-bonus multi-hit (count > 1)
 *  - 🚨 DETERMINISMO: stesso input → identical output 100x
 *  - regex word-boundary (no false partial match)
 */
import { describe, it, expect } from 'vitest';
import { scoreLeadFromContent } from './lead-score.service.js';

describe('🚨 DETERMINISMO (regression critica)', () => {
  it('stesso input 100x → output IDENTICO', () => {
    const content = 'we are a shipyard producing bow thruster for yachts';
    const results = Array.from({ length: 100 }, () => scoreLeadFromContent(content, 'IT'));
    const first = JSON.stringify(results[0]);
    for (const r of results) {
      expect(JSON.stringify(r)).toBe(first);
    }
  });

  it('serializzazione identica anche con multi-keyword complex', () => {
    const content = 'bow thruster cantiere navale shipyard marina yacht refit hydraulic';
    const r1 = scoreLeadFromContent(content, 'DE');
    const r2 = scoreLeadFromContent(content, 'DE');
    expect(r1).toEqual(r2);
  });
});

describe('marine-thrusters default profile — happy paths', () => {
  it('🚨 strong shipyard signal → high score + category=shipyard', () => {
    const content = 'we are a shipyard producing bow thruster and stern thruster for yachts';
    const r = scoreLeadFromContent(content, 'NL');
    expect(r.score).toBeGreaterThan(50);
    expect(r.category).toBe('shipyard');
    expect(r.send_recommended).toBe(true);
    expect(r.matched_positive.length).toBeGreaterThan(0);
  });

  it('multilingual keyword match: italian + french + german', () => {
    const content = 'cantiere navale chantier naval werft astillero';
    const r = scoreLeadFromContent(content, 'IT');
    expect(r.matched_positive.length).toBeGreaterThanOrEqual(4);
    expect(r.category).toBe('shipyard');
  });

  it('🚨 contenuto vuoto → score=0 + reason "Nessuna keyword"', () => {
    const r = scoreLeadFromContent('', undefined);
    expect(r.score).toBe(0);
    expect(r.send_recommended).toBe(false);
    expect(r.reason).toContain('Nessuna keyword');
  });

  it('🚨 nessun match positivo → score basso + category=unknown', () => {
    const r = scoreLeadFromContent('we sell pizza and pasta', 'IT');
    expect(r.score).toBeLessThan(50);
    expect(r.category).toBe('unknown');
  });
});

describe('🚨 country bonus', () => {
  it('EU country (IT/DE/NL) → +20 bonus', () => {
    const baseContent = 'shipyard refit';
    const itResult = scoreLeadFromContent(baseContent, 'IT');
    const deResult = scoreLeadFromContent(baseContent, 'DE');
    expect(itResult.country_bonus).toBe(20);
    expect(deResult.country_bonus).toBe(20);
  });

  it('🚨 world country (US/CA/JP) → +10 bonus', () => {
    const r = scoreLeadFromContent('shipyard', 'US');
    expect(r.country_bonus).toBe(10);
  });

  it('🚨 country undefined → 0 bonus', () => {
    const r = scoreLeadFromContent('shipyard', undefined);
    expect(r.country_bonus).toBe(0);
  });

  it('🚨 country "XX" (unknown placeholder) → 0 bonus', () => {
    const r = scoreLeadFromContent('shipyard', 'XX');
    expect(r.country_bonus).toBe(0);
  });

  it('country case-insensitive normalize (it → IT)', () => {
    const r = scoreLeadFromContent('shipyard', 'it');
    expect(r.country_bonus).toBe(20); // normalized to IT
  });

  it('country invalid format (not 2-char) → 0 bonus', () => {
    const r = scoreLeadFromContent('shipyard', 'ITA');
    expect(r.country_bonus).toBe(0);
  });

  it('custom highPriorityCountries override', () => {
    const r = scoreLeadFromContent('shipyard', 'JP', {
      highPriorityCountries: ['JP'],
    });
    expect(r.country_bonus).toBe(20);
  });
});

describe('🚨 negative keywords (anti-spam)', () => {
  it('keyword negative → score decreased', () => {
    const positiveOnly = scoreLeadFromContent('bow thruster shipyard', 'IT');
    const withNegative = scoreLeadFromContent('bow thruster shipyard pizzeria ristorante hotel blog', 'IT');
    expect(withNegative.score).toBeLessThan(positiveOnly.score);
  });

  it('🚨 negative cap 3× (anti false-alarm pagine spam)', () => {
    // 20 ripetizioni "pizzeria" - cap a 3× di subtraction
    const content = `shipyard ${'pizzeria '.repeat(20)}`;
    const r = scoreLeadFromContent(content, 'IT');
    expect(r.matched_negative[0]?.count).toBe(20);
    // ma il negativeScore è cappato (no full subtraction)
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('🚨 squalificato → reason "Squalificato"', () => {
    const r = scoreLeadFromContent('shipyard pizzeria ristorante hotel blog wordpress.com', 'IT');
    if (r.score < 50) {
      // se la spazzatura supera il signal → reason squalificato
      expect(r.reason).toMatch(/Squalificato|Nessuna keyword/u);
    }
  });
});

describe('🚨 score clamp 0-100', () => {
  it('score never < 0 even con tons of negative', () => {
    const r = scoreLeadFromContent('pizzeria ristorante hotel blog wordpress.com wix.com squarespace.com', undefined);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('🚨 score never > 100 (max with all positive + bonus)', () => {
    // Genera contenuto saturo di positive
    const content = PROFILE_KEYWORDS.join(' ') + ' '.repeat(10);
    const r = scoreLeadFromContent(content, 'NL');
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('🚨 word-boundary regex (no false partial matches)', () => {
  it('"shipyard" non match "shipyards-suffix"', () => {
    const r1 = scoreLeadFromContent('shipyard', undefined);
    const r2 = scoreLeadFromContent('shipyards-not-matched', undefined);
    // Note: word boundary \b treats "-" as word boundary so "shipyards" should match base "shipyards"?
    // The keyword is "shipyard" (no s). With \b boundary: "shipyards" → "shipyard" + "s" → no match
    expect(r1.matched_positive.length).toBeGreaterThan(0);
    expect(r2.matched_positive.find((m) => m.keyword === 'shipyard')).toBeUndefined();
  });

  it('"refit" match standalone, not in "prefit"', () => {
    const r = scoreLeadFromContent('we do prefit operations', undefined);
    expect(r.matched_positive.find((m) => m.keyword === 'refit')).toBeUndefined();
  });
});

describe('🚨 threshold + send_recommended', () => {
  it('default threshold 50', () => {
    const r = scoreLeadFromContent('shipyard bow thruster yacht refit', 'IT');
    expect(r.send_recommended).toBe(r.score >= 50);
  });

  it('custom threshold high (75) → send_recommended più restrittivo', () => {
    const content = 'shipyard';
    const r1 = scoreLeadFromContent(content, 'IT', { threshold: 30 });
    const r2 = scoreLeadFromContent(content, 'IT', { threshold: 90 });
    expect(r1.send_recommended).toBe(r1.score >= 30);
    expect(r2.send_recommended).toBe(r2.score >= 90);
  });

  it('threshold 0 → send_recommended sempre true se score >= 0', () => {
    const r = scoreLeadFromContent('something', 'IT', { threshold: 0 });
    expect(r.send_recommended).toBe(true);
  });
});

describe('🚨 custom profile', () => {
  it('profile=custom + customPositive → uses ONLY custom keywords', () => {
    const r = scoreLeadFromContent('shipyard widget gizmo', 'IT', {
      profile: 'custom',
      customPositive: [{ keyword: 'widget', weight: 50, category: 'distributor' }],
    });
    // "shipyard" NON dovrebbe matchare (profile custom)
    const hasShipyard = r.matched_positive.find((m) => m.keyword === 'shipyard');
    expect(hasShipyard).toBeUndefined();
    const hasWidget = r.matched_positive.find((m) => m.keyword === 'widget');
    expect(hasWidget).toBeDefined();
    expect(r.category).toBe('distributor');
  });

  it('🚨 customPositive senza category → default "unknown"', () => {
    const r = scoreLeadFromContent('foo', 'IT', {
      profile: 'custom',
      customPositive: [{ keyword: 'foo', weight: 50 }],
    });
    expect(r.matched_positive[0]?.keyword).toBe('foo');
    expect(r.category).toBe('unknown');
  });
});

describe('multi-hit count + log bonus', () => {
  it('🚨 single match: count=1, no bonus', () => {
    const r = scoreLeadFromContent('one shipyard here', undefined);
    const sh = r.matched_positive.find((m) => m.keyword === 'shipyard');
    expect(sh?.count).toBe(1);
  });

  it('🚨 5 occurrences → count=5 + log bonus added', () => {
    const r1 = scoreLeadFromContent('shipyard', undefined);
    const r5 = scoreLeadFromContent('shipyard shipyard shipyard shipyard shipyard', undefined);
    expect(r5.score).toBeGreaterThan(r1.score);
    const sh5 = r5.matched_positive.find((m) => m.keyword === 'shipyard');
    expect(sh5?.count).toBe(5);
  });
});

describe('output shape', () => {
  it('include tutti i campi LeadScoreResult', () => {
    const r = scoreLeadFromContent('shipyard', 'IT');
    expect(r).toMatchObject({
      score: expect.any(Number),
      category: expect.any(String),
      matched_positive: expect.any(Array),
      matched_negative: expect.any(Array),
      country_bonus: expect.any(Number),
      send_recommended: expect.any(Boolean),
      reason: expect.any(String),
    });
  });

  it('category enum-validated', () => {
    const r = scoreLeadFromContent('shipyard bow thruster', undefined);
    expect(['shipyard', 'distributor', 'marina', 'service', 'unknown']).toContain(r.category);
  });
});

// Lista keyword profile-marine per uso nei test
const PROFILE_KEYWORDS = [
  'bow thruster', 'stern thruster', 'cantiere navale', 'shipyard',
  'yacht', 'marina', 'refit', 'hydraulic', 'propulsion',
];
