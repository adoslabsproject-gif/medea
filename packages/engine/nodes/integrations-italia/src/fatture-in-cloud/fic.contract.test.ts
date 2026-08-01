/**
 * Contract test ANTI-DRIFT — italia_fatture_in_cloud_invoice / _client.
 *
 * Storia (review nodi): le description promettevano output normalizzati
 * ({ invoiceId, number, pdfUrl, sdiStatus } e { clientId, found, created, fullData })
 * che l'executor NON produceva (ritornava il body FIC raw / shape divergente), e
 * un configField paymentDays IGNORATO. RISOLTO IMPLEMENTANDO normalizzazione +
 * payments_list (fic-mapping.ts). Questo guard lega la description ai campi reali.
 */
import { describe, it, expect } from 'vitest';
import { fattureInCloudInvoice, fattureInCloudClient } from './index.js';
import { normalizeInvoiceOutput, normalizeClientOutput } from './fic-mapping.js';

describe('italia_fatture_in_cloud_invoice — contract', () => {
  const description = fattureInCloudInvoice.def.description ?? '';

  it('🚨 i campi di output dichiarati esistono nella shape normalizzata reale', () => {
    const sample = normalizeInvoiceOutput({ data: { id: 1, number: 'n', url: 'u', ei_status: 's' } });
    for (const field of ['invoiceId', 'number', 'pdfUrl', 'sdiStatus', 'raw']) {
      expect(description, `output "${field}" non documentato`).toContain(field);
      expect(sample, `output "${field}" non prodotto`).toHaveProperty(field);
    }
  });

  it('🚨 paymentDays è documentato come usato (non più campo morto)', () => {
    expect(description).toMatch(/paymentDays|termine pagamento/i);
    const hasField = (fattureInCloudInvoice.def.configFields ?? []).some((f) => f.key === 'paymentDays');
    expect(hasField).toBe(true);
  });
});

describe('italia_fatture_in_cloud_client — contract', () => {
  const description = fattureInCloudClient.def.description ?? '';

  it('🚨 i campi di output dichiarati esistono nella shape normalizzata reale', () => {
    const sample = normalizeClientOutput({ found: true, created: false, client: { id: 1 } });
    for (const field of ['clientId', 'found', 'created', 'fullData']) {
      expect(description, `output "${field}" non documentato`).toContain(field);
      expect(sample, `output "${field}" non prodotto`).toHaveProperty(field);
    }
  });
});
