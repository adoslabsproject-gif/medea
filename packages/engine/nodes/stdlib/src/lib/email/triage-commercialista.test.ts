/**
 * Test del triage commercialista IT.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { classifyCommercialistaEmail } from './triage-commercialista.js';

describe('classifyCommercialistaEmail', () => {
  it('classifies "sollecito" with high confidence on single match', () => {
    const r = classifyCommercialistaEmail({
      subject: 'SOLLECITO pagamento fattura 003/25',
      body: 'Da: cliente@x.it...',
    });
    expect(r.label).toBe('sollecito');
    expect(r.urgencyTier).toBe('high');
    expect(r.suggestedOperator).toBe('titolare@studio');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('classifies a PEC receipt as pec_legal', () => {
    const r = classifyCommercialistaEmail({
      subject: 'PEC: Ricevuta di accettazione',
      body: 'Busta di trasporto inclusa',
    });
    expect(r.label).toBe('pec_legal');
    expect(r.urgencyTier).toBe('high');
    expect(r.matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies F24 with normal/high tier', () => {
    const r = classifyCommercialistaEmail({
      subject: 'F24 ravvedimento operoso',
      body: 'codice tributo 1040',
    });
    expect(r.label).toBe('f24');
    expect(r.urgencyTier).toBe('high');
  });

  it('classifies IVA when LIPE / esterometro present', () => {
    const r = classifyCommercialistaEmail({
      subject: 'Liquidazione periodica IVA',
      body: 'esterometro Q4',
    });
    expect(r.label).toBe('iva');
  });

  it('classifies fiscale (730 / 770 / unico)', () => {
    const r = classifyCommercialistaEmail({
      subject: '730/2025',
      body: 'dichiarazione dei redditi',
    });
    expect(r.label).toBe('fiscale');
  });

  it('classifies forfettario with multiple synonym keywords', () => {
    const r = classifyCommercialistaEmail({
      subject: 'Passaggio regime forfettario flat tax',
      body: 'apertura partita iva',
    });
    expect(r.label).toBe('forfettario');
  });

  it('classifies bilancio + nota integrativa', () => {
    const r = classifyCommercialistaEmail({
      subject: 'Deposito bilancio CCIAA',
      body: 'nota integrativa allegata',
    });
    expect(r.label).toBe('bilancio');
  });

  it('classifies payment ricevuto', () => {
    const r = classifyCommercialistaEmail({
      subject: 'Bonifico effettuato per fattura 12/25',
      body: 'in attesa di pagamento ricevuto',
    });
    expect(r.label).toBe('payment');
    expect(r.urgencyTier).toBe('low');
  });

  it('returns "altro" with confidence ~0.1 when nothing matches', () => {
    const r = classifyCommercialistaEmail({
      subject: 'Buongiorno',
      body: 'Le auguro buone vacanze, a presto.',
    });
    expect(r.label).toBe('altro');
    expect(r.confidence).toBeLessThan(0.2);
    expect(r.suggestedOperator).toBe('segreteria@studio');
  });

  it('overrides operator and reply template per label via opts', () => {
    const r = classifyCommercialistaEmail(
      { subject: 'F24', body: '' },
      { operators: { f24: 'custom@studio' }, replyTemplates: { f24: 'OK' } },
    );
    expect(r.suggestedOperator).toBe('custom@studio');
    expect(r.suggestedReplyTemplate).toBe('OK');
  });

  it('returns altro on empty input', () => {
    const r = classifyCommercialistaEmail({ subject: '', body: '' });
    expect(r.label).toBe('altro');
    expect(r.matchedKeywords).toEqual([]);
  });

  it('is case-insensitive in keyword matching', () => {
    const r = classifyCommercialistaEmail({ subject: 'F24 RAVVEDIMENTO', body: '' });
    expect(r.label).toBe('f24');
  });
});
