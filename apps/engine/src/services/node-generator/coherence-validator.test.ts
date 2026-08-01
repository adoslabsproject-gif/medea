/**
 * Test coherence-validator — def↔executor. Bug-bounty: config key non dichiarata,
 * secret non dichiarato, select senza options; + i NON-falsi-positivi (chiavi e
 * secret correttamente dichiarati → zero violazioni).
 */
import { describe, it, expect } from 'vitest';
import { validateCoherence, type CoherenceDefView } from './coherence-validator.js';

describe('validateCoherence', () => {
  it('🚨 config.<key> non dichiarata → unknown_config_key (error)', () => {
    const def: CoherenceDefView = { configFields: [{ key: 'url', type: 'text' }] };
    const v = validateCoherence(def, 'async function execute(config,i,x){ return { a: config.apiKey, b: config.url }; }');
    expect(v.filter((x) => x.kind === 'unknown_config_key').map((x) => x.message).join()).toMatch(/apiKey/u);
    // url È dichiarata → NON deve comparire
    expect(v.some((x) => x.kind === 'unknown_config_key' && x.message.includes('config.url'))).toBe(false);
  });

  it('🚨 secret usato ma non dichiarato come field secret → undeclared_secret', () => {
    const def: CoherenceDefView = { configFields: [{ key: 'TOKEN', type: 'text' }] }; // type text, NON secret
    const v = validateCoherence(def, 'async function execute(c,i,ctx){ return { t: ctx.secrets["TOKEN"] }; }');
    expect(v.some((x) => x.kind === 'undeclared_secret')).toBe(true);
  });

  it('secret correttamente dichiarato (type secret) → nessuna violazione', () => {
    const def: CoherenceDefView = { configFields: [{ key: 'API_KEY', type: 'secret' }] };
    const v = validateCoherence(def, 'async function execute(c,i,ctx){ return { t: ctx.secrets["API_KEY"] }; }');
    expect(v.some((x) => x.kind === 'undeclared_secret')).toBe(false);
  });

  it('🚨 select senza options → warning (non blocca)', () => {
    const def: CoherenceDefView = { configFields: [{ key: 'mode', type: 'select' }] };
    const v = validateCoherence(def, 'async function execute(c,i,x){ return {}; }');
    const sel = v.find((x) => x.kind === 'select_without_options');
    expect(sel?.severity).toBe('warning');
  });

  it('select CON options → nessun warning', () => {
    const def: CoherenceDefView = { configFields: [{ key: 'mode', type: 'select', options: ['a', 'b'] }] };
    expect(validateCoherence(def, 'async function execute(c,i,x){ return {}; }')).toEqual([]);
  });

  it('def senza configFields + executor che non legge config → nessuna violazione', () => {
    expect(validateCoherence({}, 'async function execute(c,i,x){ return { ok: true }; }')).toEqual([]);
  });
});
