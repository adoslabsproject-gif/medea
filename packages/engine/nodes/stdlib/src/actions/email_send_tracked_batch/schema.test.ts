/**
 * Test del cap anti-DoS sull'array recipients (config + input).
 *
 * I campi singoli erano cappati ma l'ARRAY no → un upstream (db_query) poteva iniettare
 * un numero illimitato di destinatari = invii illimitati (DoS/toll). `.max(10000)` chiude.
 */
import { describe, it, expect } from 'vitest';
import {
  EmailSendTrackedBatchConfigSchema,
  EmailSendTrackedBatchInputSchema,
} from './schema.js';

const recipient = (i: number) => ({ leadId: `lead-${i}`, to: `u${i}@example.com` });
const makeRecipients = (n: number) => Array.from({ length: n }, (_, i) => recipient(i));

// Test ISOLATO sul campo `recipients` (via `.shape`) per provare il `.max()` senza
// dipendere dagli altri campi richiesti del config completo.
const cfgRecipients = EmailSendTrackedBatchConfigSchema.shape.recipients;
const inRecipients = EmailSendTrackedBatchInputSchema.shape.recipients;

describe('email_send_tracked_batch — cap recipients (anti-DoS)', () => {
  it('config.recipients: 10.000 → OK; 10.001 → RIFIUTATO (cap)', () => {
    expect(cfgRecipients.safeParse(makeRecipients(10_000)).success).toBe(true);
    expect(cfgRecipients.safeParse(makeRecipients(10_001)).success).toBe(false);
  });

  it('🚨 input.recipients (es. da db_query upstream): 10.001 → RIFIUTATO', () => {
    expect(inRecipients.safeParse(makeRecipients(10_001)).success).toBe(false);
  });

  it('input.recipients: lista piccola → OK (anti-regressione)', () => {
    expect(inRecipients.safeParse(makeRecipients(3)).success).toBe(true);
  });
});
