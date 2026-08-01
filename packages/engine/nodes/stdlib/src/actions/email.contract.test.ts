/**
 * Contract test ANTI-ASPIRAZIONALE — action_send_email.
 *
 * Verificato contro l'executor runtime (executors/nodemailer.ts):
 *  - REALI (NON toccare i claim): SPF/DKIM/DMARC pre-flight (off/warn/strict via
 *    EmailDeliverabilityService), DKIM signing inline, messageId nell'output.
 *  - ASPIRAZIONALI (rimossi dalla description finché non implementati): retry interno
 *    "3x", ricezione bounce via IMAP, audit-log-on-send. La modalità si chiama 'warn'
 *    (NON 'lenient' come diceva la description).
 * Il test impedisce che i claim fantasma o il nome 'lenient' tornino.
 */
import { describe, it, expect } from 'vitest';
import { sendEmailNode } from './email.js';

const def = sendEmailNode.def;
const description = def.description;

function selectOptions(key: string): readonly string[] {
  const field = def.configFields.find((f) => f.key === key);
  return field?.type === 'select' ? field.options : [];
}

describe('action_send_email — contract description ⊆ schema (anti-aspirazionale)', () => {
  it('🚨 deliverabilityCheck enum = off/warn/strict; la description usa questi nomi (mai "lenient")', () => {
    expect(selectOptions('deliverabilityCheck')).toEqual(['off', 'warn', 'strict']);
    expect(description).toMatch(/off\/warn\/strict/);
    expect(description).not.toMatch(/lenient/i);
  });

  it('🚨 NON promette feature non implementate (bounce-IMAP, retry 3x interno, audit-log-on-send)', () => {
    expect(description).not.toMatch(/bounce/i);
    expect(description).not.toMatch(/imap/i);
    expect(description).not.toMatch(/retry 3x/i);
    // L'audit-log-on-send non esiste; il messageId è solo nell'output del nodo.
    expect(description).not.toMatch(/audit log su ogni invio/i);
    expect(description).toMatch(/messageId.*output|output.*messageId/i);
  });

  it('🚨 i claim REALI restano documentati (SPF/DKIM/DMARC pre-flight, DKIM signing)', () => {
    expect(description).toMatch(/SPF\/DKIM\/DMARC/);
    expect(description).toMatch(/DKIM/);
    // I campi reali esistono nello schema.
    expect(def.configFields.some((f) => f.key === 'deliverabilityCheck')).toBe(true);
    expect(def.configFields.some((f) => f.key === 'dkimPrivateKey')).toBe(true);
  });
});
