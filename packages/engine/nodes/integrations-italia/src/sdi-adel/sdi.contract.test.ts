/**
 * Contract test ANTI-DRIFT — italia_sdi_send_invoice.
 *
 * Storia: la description prometteva "Validazione XSD pre-invio" mentre l'executor NON
 * validava (claim fantasma, rimosso). RISOLTO IMPLEMENTANDO la validazione XSD reale
 * contro lo schema UFFICIALE FatturaPA v1.2.2 (xsd-validator.ts, libxml2-wasm, offline,
 * default ON via configField validateXsd). Ora il guard pretende il CONTRARIO: il claim
 * XSD DEVE esserci col suo configField reale, accanto a XAdES-BES + SDIcoop/ADEL.
 */
import { describe, it, expect } from 'vitest';
import { sdiSendInvoice } from './index.js';

const def = sdiSendInvoice.def;
const description = def.description ?? '';
const validateXsdField = (def.configFields ?? []).find((f) => f.key === 'validateXsd');

describe('italia_sdi_send_invoice — contract description (anti-drift)', () => {
  it('🚨 dichiara la validazione XSD UFFICIALE pre-invio (ora implementata) + il suo configField', () => {
    expect(description).toMatch(/validazione\s+xsd\s+pre-invio/i);
    expect(description).toMatch(/ufficiale.*FatturaPA\s+v?1\.2\.2|FatturaPA\s+v?1\.2\.2/i);
    // Il toggle reale esiste, default ON.
    expect(validateXsdField, 'configField validateXsd mancante').toBeDefined();
    expect(validateXsdField?.type).toBe('boolean');
    expect(validateXsdField?.defaultValue).toBe('true');
  });

  it('claim REALI presenti: XAdES-BES + canale SDIcoop/ADEL', () => {
    expect(description).toMatch(/XAdES-BES/);
    expect(description).toMatch(/SDIcoop|ADEL/);
  });
});
