/**
 * Test validateFatturaPaXsd — bug-bounty + anti-regressione.
 *
 * Prova la validazione XSD REALE contro lo schema ufficiale FatturaPA v1.2.2:
 *  - una fattura UFFICIALE dell'Agenzia (fixture IT01234567890_FPR01.xml) → VALIDA;
 *  - XML strutturalmente non conformi (root ok ma contenuto errato, fuori schema,
 *    campi obbligatori mancanti, valori fuori formato) → INVALIDI con errori;
 *  - import xmldsig risolto offline (la firma ds:Signature è nello schema);
 *  - XML malformato → invalid (non throw).
 *
 * ⚠️ Anti-regressione: se l'embed perdesse l'import xmldsig o lo schema, una
 * fattura valida diventerebbe invalida → questi test diventano rossi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateFatturaPaXsd, __resetXsdValidator } from './xsd-validator.js';

const here = dirname(fileURLToPath(import.meta.url));
const validInvoice = readFileSync(join(here, '__fixtures__', 'IT01234567890_FPR01.xml'), 'utf-8');

beforeEach(() => {
  __resetXsdValidator();
});

describe('validateFatturaPaXsd — fattura ufficiale', () => {
  it("🚨 fattura ufficiale FPR01 dell'Agenzia → VALIDA (zero errori)", () => {
    const r = validateFatturaPaXsd(validInvoice);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('validator riusabile: 2 validazioni consecutive della stessa fattura → entrambe valide', () => {
    expect(validateFatturaPaXsd(validInvoice).valid).toBe(true);
    expect(validateFatturaPaXsd(validInvoice).valid).toBe(true);
  });
});

describe('validateFatturaPaXsd — non conformi (devono essere INVALIDI)', () => {
  it('🚨 root FatturaElettronica ma contenuto fuori schema (Bogus) → INVALIDO', () => {
    const xml =
      '<?xml version="1.0"?><p:FatturaElettronica versione="FPR12" ' +
      'xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">' +
      '<Bogus>non conforme</Bogus></p:FatturaElettronica>';
    const r = validateFatturaPaXsd(xml);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(' ')).toMatch(/FatturaElettronicaHeader|Bogus|not expected/i);
  });

  it('🚨 XML totalmente fuori schema → INVALIDO', () => {
    const r = validateFatturaPaXsd('<foo><bar/></foo>');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('🚨 namespace sbagliato sulla root → INVALIDO (no matching global declaration)', () => {
    const xml =
      '<?xml version="1.0"?><FatturaElettronica xmlns="urn:wrong-namespace">' +
      '<x/></FatturaElettronica>';
    const r = validateFatturaPaXsd(xml);
    expect(r.valid).toBe(false);
  });

  it('🚨 fattura valida ma con un campo obbligatorio rimosso → INVALIDO', () => {
    // Rimuove il blocco DatiTrasmissione (obbligatorio in FatturaElettronicaHeader).
    const broken = validInvoice.replace(/<DatiTrasmissione>[\s\S]*?<\/DatiTrasmissione>/u, '');
    expect(broken).not.toBe(validInvoice); // il replace ha morso
    const r = validateFatturaPaXsd(broken);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('🚨 XML malformato (tag non chiuso) → INVALIDO, NON throw', () => {
    const r = validateFatturaPaXsd('<p:FatturaElettronica><unclosed>');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/XML non valido|non valido/i);
  });

  it('🚨 stringa vuota → INVALIDO, NON throw', () => {
    const r = validateFatturaPaXsd('');
    expect(r.valid).toBe(false);
  });
});
