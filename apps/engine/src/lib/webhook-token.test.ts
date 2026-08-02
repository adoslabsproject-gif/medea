/**
 * webhook-token — contract test della derivazione e della verifica con
 * grace window. Questi test ISTITUZIONALIZZANO il contract di rotazione:
 *   • il token dipende SOLO da (secret, workflowId) — deterministico
 *   • ruotare il secret CAMBIA il token (è il bug sistemico dei link cablati)
 *   • la grace window accetta i token del secret precedente e lo SEGNALA
 *   • fail-closed: senza secret non esiste alcun token valido
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  deriveWebhookTokenFromSecret,
  deriveDefaultWebhookToken,
  verifyDefaultWebhookToken,
} from './webhook-token.js';

const SECRET_A = 'secret-A-abcdefghijklmnopqrstuvwxyz-123456';
const SECRET_B = 'secret-B-abcdefghijklmnopqrstuvwxyz-654321';
const WF = 'streammy_search_wf1';

const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup.MEDEA_SSO_SECRET = process.env.MEDEA_SSO_SECRET;
  envBackup.MEDEA_WEBHOOK_GRACE_SECRETS = process.env.MEDEA_WEBHOOK_GRACE_SECRETS;
  process.env.MEDEA_SSO_SECRET = SECRET_A;
  delete process.env.MEDEA_WEBHOOK_GRACE_SECRETS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('deriveWebhookTokenFromSecret', () => {
  it('combacia byte-per-byte col verificatore storico (HMAC-SHA256 hex[:32])', () => {
    const expected = createHmac('sha256', SECRET_A)
      .update(`webhook:${WF}`)
      .digest('hex')
      .slice(0, 32);
    expect(deriveWebhookTokenFromSecret(SECRET_A, WF)).toBe(expected);
    expect(expected).toMatch(/^[a-f0-9]{32}$/u);
  });

  it('è deterministico e isolato per workflowId', () => {
    expect(deriveWebhookTokenFromSecret(SECRET_A, WF)).toBe(
      deriveWebhookTokenFromSecret(SECRET_A, WF),
    );
    expect(deriveWebhookTokenFromSecret(SECRET_A, 'altro-wf')).not.toBe(
      deriveWebhookTokenFromSecret(SECRET_A, WF),
    );
  });

  it('CONTRACT rotazione: secret diverso → token diverso (il perché dei link rotti)', () => {
    expect(deriveWebhookTokenFromSecret(SECRET_B, WF)).not.toBe(
      deriveWebhookTokenFromSecret(SECRET_A, WF),
    );
  });

  it('fail-closed: secret vuoto o corto → stringa vuota', () => {
    expect(deriveWebhookTokenFromSecret('', WF)).toBe('');
    expect(deriveWebhookTokenFromSecret('troppo-corto', WF)).toBe('');
  });
});

describe('deriveDefaultWebhookToken', () => {
  it('legge il secret corrente da env a OGNI chiamata (non snapshot)', () => {
    const before = deriveDefaultWebhookToken(WF);
    process.env.MEDEA_SSO_SECRET = SECRET_B;
    const after = deriveDefaultWebhookToken(WF);
    expect(before).toBe(deriveWebhookTokenFromSecret(SECRET_A, WF));
    expect(after).toBe(deriveWebhookTokenFromSecret(SECRET_B, WF));
    expect(after).not.toBe(before);
  });

  it('fail-closed senza env', () => {
    delete process.env.MEDEA_SSO_SECRET;
    expect(deriveDefaultWebhookToken(WF)).toBe('');
  });
});

describe('verifyDefaultWebhookToken', () => {
  it('accetta il token corrente senza flag grace', () => {
    const token = deriveDefaultWebhookToken(WF);
    expect(verifyDefaultWebhookToken(WF, token)).toEqual({ valid: true, viaGraceSecret: false });
  });

  it('rifiuta token sbagliato, vuoto, o del workflow sbagliato', () => {
    expect(verifyDefaultWebhookToken(WF, 'a'.repeat(32)).valid).toBe(false);
    expect(verifyDefaultWebhookToken(WF, '').valid).toBe(false);
    expect(verifyDefaultWebhookToken(WF, deriveDefaultWebhookToken('altro-wf')).valid).toBe(false);
  });

  it('GRACE: accetta il token del secret precedente e lo SEGNALA', () => {
    const oldToken = deriveWebhookTokenFromSecret(SECRET_A, WF);
    process.env.MEDEA_SSO_SECRET = SECRET_B; // rotazione
    expect(verifyDefaultWebhookToken(WF, oldToken).valid).toBe(false); // senza grace → rotto
    process.env.MEDEA_WEBHOOK_GRACE_SECRETS = SECRET_A;
    expect(verifyDefaultWebhookToken(WF, oldToken)).toEqual({ valid: true, viaGraceSecret: true });
    // Il token CORRENTE resta accettato senza flag grace.
    expect(verifyDefaultWebhookToken(WF, deriveWebhookTokenFromSecret(SECRET_B, WF))).toEqual({
      valid: true,
      viaGraceSecret: false,
    });
  });

  it('GRACE: lista comma-separated, entry corte scartate, spazi tollerati', () => {
    const oldToken = deriveWebhookTokenFromSecret(SECRET_A, WF);
    process.env.MEDEA_SSO_SECRET = SECRET_B;
    process.env.MEDEA_WEBHOOK_GRACE_SECRETS = `corto, ${SECRET_A} ,altro-corto`;
    expect(verifyDefaultWebhookToken(WF, oldToken)).toEqual({ valid: true, viaGraceSecret: true });
    // Un token derivato da un'entry SCARTATA (corta) non deve mai passare.
    expect(
      verifyDefaultWebhookToken(WF, deriveWebhookTokenFromSecret('corto'.repeat(7), WF)).valid,
    ).toBe(false);
  });

  it('fail-closed totale: né secret né grace → nulla è valido', () => {
    delete process.env.MEDEA_SSO_SECRET;
    expect(verifyDefaultWebhookToken(WF, '').valid).toBe(false);
    expect(verifyDefaultWebhookToken(WF, 'x'.repeat(32)).valid).toBe(false);
  });
});
