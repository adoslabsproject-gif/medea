/**
 * Contract test ANTI-ASPIRAZIONALE — italia_zucchetti_payroll.
 *
 * Bug trovati vs executor reale (italian.ts zucchettiPayrollExecutor):
 *  - "OAuth2": FALSO → l'auth è un Bearer token statico (configField `apiToken`),
 *    nessun flow OAuth2 (no client_id/secret/token-exchange).
 *  - "filtro dipendenti (per codice/dipartimento)" + "modalità (preview/finale)": NON
 *    esistono come configField né nel body POST {companyCode, period, dryRun}.
 * Riconciliato: Bearer token + dryRun; output passthrough. Questo guard lo blinda.
 */
import { describe, it, expect } from 'vitest';
import { zucchettiPayroll } from './index.js';

const def = zucchettiPayroll.def;
const description = def.description ?? '';
const keys = new Set((def.configFields ?? []).map((f) => f.key));

describe('italia_zucchetti_payroll — contract description ⊆ config reale', () => {
  it('🚨 NON dichiara OAuth2 (auth reale = Bearer token statico apiToken)', () => {
    expect(description).not.toMatch(/OAuth\s*2/i);
    expect(keys.has('apiToken')).toBe(true);
  });

  it('🚨 NON promette config inesistenti (filtro dipendenti, preview/finale)', () => {
    expect(description).not.toMatch(/filtro dipendenti/i);
    expect(description).not.toMatch(/preview\/finale/i);
    // I campi citati come input esistono davvero.
    expect(keys.has('period')).toBe(true);
    expect(keys.has('dryRun')).toBe(true);
    // E NON esiste un campo "filtro dipendenti".
    expect([...keys].some((k) => /employee|dipendent|filter/i.test(k))).toBe(false);
  });
});
