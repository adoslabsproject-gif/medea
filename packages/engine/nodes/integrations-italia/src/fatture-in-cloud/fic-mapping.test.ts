/**
 * Test fic-mapping — bug-bounty + anti-regressione.
 *
 * Normalizzazione output (shape stabile dalla risposta FIC raw) + calcolo totale
 * DIFENSIVO per payments_list (paymentDays). Edge: campi assenti, items rotti,
 * gross vs net+vat, qty mancante/negativa, giorni invalidi → omissione sicura.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeInvoiceOutput, normalizeClientOutput,
  computeItemsGrossTotal, buildPaymentsList, dueDateFromNow,
} from './fic-mapping.js';

describe('normalizeInvoiceOutput', () => {
  it('🚨 estrae invoiceId/number/pdfUrl/sdiStatus da { data: {…} } + raw', () => {
    const resp = { data: { id: 42, number: '12/2026', url: 'https://fic/inv.pdf', ei_status: 'sent' } };
    const out = normalizeInvoiceOutput(resp);
    expect(out).toMatchObject({ invoiceId: 42, number: '12/2026', pdfUrl: 'https://fic/inv.pdf', sdiStatus: 'sent' });
    expect(out.raw).toBe(resp);
  });

  it('🚨 campi assenti → null o stringa vuota (mai undefined/crash); id stringa → number', () => {
    expect(normalizeInvoiceOutput({ data: { id: '7' } })).toMatchObject({ invoiceId: 7, number: '', pdfUrl: '', sdiStatus: '' });
    expect(normalizeInvoiceOutput({})).toMatchObject({ invoiceId: null });
    expect(normalizeInvoiceOutput(null)).toMatchObject({ invoiceId: null, raw: null });
  });

  it('fallback pdfUrl su url_attachment', () => {
    expect(normalizeInvoiceOutput({ data: { url_attachment: 'https://fic/a.pdf' } }).pdfUrl).toBe('https://fic/a.pdf');
  });
});

describe('normalizeClientOutput', () => {
  it('🚨 trovato → clientId + found true + fullData', () => {
    const out = normalizeClientOutput({ found: true, created: false, client: { id: 9, name: 'ACME' } });
    expect(out).toMatchObject({ clientId: 9, found: true, created: false });
    expect(out.fullData).toEqual({ id: 9, name: 'ACME' });
  });

  it('🚨 non trovato e non creato → clientId null, fullData null', () => {
    expect(normalizeClientOutput({ found: false, created: false, client: null }))
      .toMatchObject({ clientId: null, found: false, created: false, fullData: null });
  });

  it('🚨 created è SEMPRE un bool (non l\'oggetto) — bug della vecchia shape', () => {
    const out = normalizeClientOutput({ found: false, created: true, client: { id: 5 } });
    expect(out.created).toBe(true);
    expect(out.clientId).toBe(5);
  });
});

describe('computeItemsGrossTotal — difensivo', () => {
  it('🚨 net + vat% → lordo; somma per qty', () => {
    expect(computeItemsGrossTotal([{ net_price: 100, vat: 22, qty: 2 }])).toBe(244); // 100*1.22*2
  });

  it('gross_price ha precedenza su net', () => {
    expect(computeItemsGrossTotal([{ gross_price: 50, net_price: 999, qty: 1 }])).toBe(50);
  });

  it('qty default 1; vat oggetto { value }', () => {
    expect(computeItemsGrossTotal([{ net_price: 10, vat: { value: 10 } }])).toBe(11);
  });

  it('🚨 nessuna riga calcolabile → null (no payload azzardato)', () => {
    expect(computeItemsGrossTotal([{ foo: 'bar' }, {}])).toBeNull();
    expect(computeItemsGrossTotal([])).toBeNull();
  });

  it('🚨 qty negativa/zero → riga saltata', () => {
    expect(computeItemsGrossTotal([{ net_price: 100, qty: -1 }, { net_price: 50, vat: 0, qty: 1 }])).toBe(50);
  });

  it('mix valido + rotto → conta solo i validi', () => {
    expect(computeItemsGrossTotal([{ net_price: 100, vat: 0, qty: 1 }, { garbage: true }])).toBe(100);
  });
  // 🚨 IVA non risolvibile su riga NET → totale inaffidabile → null (no payment errato).
  // Prima si assumeva 0% → lordo sottostimato → payments_list.amount ≠ totale FIC.
  it('🚨 riga net SENZA iva → null (non assume 0%)', () => {
    expect(computeItemsGrossTotal([{ net_price: 100, qty: 1 }])).toBeNull();
  });
  it('🚨 riga net con vat formato FIC {id} (non percentuale) → null', () => {
    expect(computeItemsGrossTotal([{ net_price: 100, vat: { id: 0 }, qty: 1 }])).toBeNull();
  });
  it('🔒 gross_price NON richiede iva → calcolabile anche senza vat', () => {
    expect(computeItemsGrossTotal([{ gross_price: 122, qty: 1 }])).toBe(122);
  });
  it('🔒 una sola riga net-ambigua annulla TUTTO il totale (conservativo)', () => {
    expect(computeItemsGrossTotal([{ net_price: 100, vat: 22, qty: 1 }, { net_price: 50, qty: 1 }])).toBeNull();
  });
});

describe('buildPaymentsList', () => {
  it('🚨 giorni invalidi (<=0/NaN) → null (omette il campo)', () => {
    expect(buildPaymentsList([{ net_price: 100, vat: 0 }], 0)).toBeNull();
    expect(buildPaymentsList([{ net_price: 100, vat: 0 }], -5)).toBeNull();
    expect(buildPaymentsList([{ net_price: 100, vat: 0 }], Number.NaN)).toBeNull();
  });

  it('🚨 totale non calcolabile → null anche con giorni validi', () => {
    expect(buildPaymentsList([{ foo: 1 }], 30)).toBeNull();
  });

  it('🚨 giorni validi + totale → 1 scadenza con due_date e amount', () => {
    const now = new Date('2026-06-20T10:00:00Z');
    const list = buildPaymentsList([{ net_price: 100, vat: 22, qty: 1 }], 30, now);
    expect(list).toEqual([{ due_date: '2026-07-20', amount: 122, status: 'not_paid' }]);
  });

  it('dueDateFromNow somma i giorni (ISO date)', () => {
    expect(dueDateFromNow(10, new Date('2026-06-25T00:00:00Z'))).toBe('2026-07-05');
  });
});
