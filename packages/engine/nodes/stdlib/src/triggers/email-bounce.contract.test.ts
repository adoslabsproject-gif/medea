/**
 * Contract test ANTI-ASPIRAZIONALE — trigger_email_bounce.
 *
 * Il nodo riusa l'infra IMAP + un parser DSN: la description deve riflettere SOLO ciò
 * che esiste (campi di output reali del BounceReport, classi hard/soft/unknown) e NON
 * promettere filtri-contenuto (subject/from regex) che NON ha — quelli sono di
 * trigger_imap. Se un claim fantasma viene aggiunto → rosso.
 */
import { describe, it, expect } from 'vitest';
import { emailBounceTriggerNode } from './email-bounce.js';

const def = emailBounceTriggerNode.def;
const description = def.description;
const configKeys = def.configFields?.map((f) => f.key) ?? [];

describe('trigger_email_bounce — contract', () => {
  it('è un trigger con id/label coerenti', () => {
    expect(def.id).toBe('trigger_email_bounce');
    expect(def.type).toBe('trigger');
  });

  it("🚨 documenta i campi REALI dell'output BounceReport (niente di inventato)", () => {
    for (const field of ['failedRecipients', 'bounceType', 'status', 'originalMessageId']) {
      expect(description, `campo output '${field}' non documentato`).toContain(field);
    }
    // classi reali del parser
    expect(description).toMatch(/hard/);
    expect(description).toMatch(/soft/);
  });

  it('🚨 NON promette filtri-contenuto che non ha (sono di trigger_imap): nessun configField di filtro', () => {
    for (const ghost of [
      'filterSubject',
      'filterFrom',
      'filterTo',
      'hasAttachment',
      'senderAllowlist',
    ]) {
      expect(configKeys, `il bounce trigger non deve avere il filtro '${ghost}'`).not.toContain(
        ghost,
      );
    }
    // riusa invece i campi connessione IMAP reali
    expect(configKeys).toContain('systemAccountId');
    expect(configKeys).toContain('mailbox');
    expect(configKeys).toContain('markSeen');
  });

  it('🚨 dichiara la base RFC corretta (3464 DSN)', () => {
    expect(description).toMatch(/RFC\s*3464/);
  });
});
