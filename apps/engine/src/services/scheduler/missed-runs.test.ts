/**
 * Le scadenze passate a vuoto vanno ritrovate — e ne va eseguita una sola.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { findLastMissedFiring, MAX_CATCHUP_WINDOW_MS } from './missed-runs.js';

/** Un cron che scatta ogni ora al minuto zero, in UTC. */
const ogniOra = (instant: Date): boolean =>
  instant.getUTCMinutes() === 0 && instant.getUTCSeconds() === 0;

/** Un cron che scatta alle 8:00 in punto, in UTC. */
const alleOtto = (instant: Date): boolean =>
  instant.getUTCHours() === 8 && instant.getUTCMinutes() === 0;

const t = (iso: string): Date => new Date(iso);

describe('recupero delle esecuzioni programmate mancate', () => {
  it('nessuna scadenza fra i due istanti → niente da recuperare', () => {
    const missed = findLastMissedFiring(
      t('2026-08-02T09:05:00Z'),
      t('2026-08-02T09:45:00Z'),
      ogniOra,
    );
    expect(missed).toBeNull();
  });

  it('una scadenza passata a vuoto viene ritrovata', () => {
    const missed = findLastMissedFiring(
      t('2026-08-02T07:30:00Z'),
      t('2026-08-02T09:30:00Z'),
      alleOtto,
    );
    expect(missed?.toISOString()).toBe('2026-08-02T08:00:00.000Z');
  });

  it('🚨 fra molte scadenze mancate se ne restituisce UNA, la più recente', () => {
    // Tre giorni di spegnimento con un cron orario: 72 scadenze mancate.
    // Recuperarle tutte vorrebbe dire 72 esecuzioni in fila.
    const missed = findLastMissedFiring(
      t('2026-07-30T10:00:00Z'),
      t('2026-08-02T10:30:00Z'),
      ogniOra,
    );
    expect(missed?.toISOString()).toBe('2026-08-02T10:00:00.000Z');
  });

  it('🚨 il minuto corrente è escluso: lo valuta il tick, contarlo qui raddoppierebbe', () => {
    // Alle 09:00 in punto il tick dello scheduler esegue per conto suo.
    const missed = findLastMissedFiring(
      t('2026-08-02T08:30:00Z'),
      t('2026-08-02T09:00:00Z'),
      ogniOra,
    );
    expect(missed).toBeNull();
  });

  it('🚨 il minuto di partenza è escluso: lì il workflow è già stato eseguito', () => {
    // L'ultima esecuzione registrata è alle 08:00; non va rieseguita.
    const missed = findLastMissedFiring(
      t('2026-08-02T08:00:00Z'),
      t('2026-08-02T08:30:00Z'),
      alleOtto,
    );
    expect(missed).toBeNull();
  });

  it('🚨 oltre la finestra massima non si guarda: si riparte da lì', () => {
    const adesso = t('2026-08-02T10:30:00Z');
    const unMeseFa = new Date(adesso.getTime() - 30 * 24 * 60 * 60 * 1000);
    const missed = findLastMissedFiring(unMeseFa, adesso, alleOtto);

    expect(missed).not.toBeNull();
    const distanza = adesso.getTime() - missed!.getTime();
    expect(distanza).toBeLessThanOrEqual(MAX_CATCHUP_WINDOW_MS);
  });

  it('un intervallo che non contiene minuti interi non produce nulla', () => {
    const missed = findLastMissedFiring(
      t('2026-08-02T08:00:10Z'),
      t('2026-08-02T08:00:50Z'),
      ogniOra,
    );
    expect(missed).toBeNull();
  });

  it('gli istanti restituiti cadono sempre sul minuto esatto', () => {
    const missed = findLastMissedFiring(
      t('2026-08-02T07:13:27Z'),
      t('2026-08-02T09:41:13Z'),
      alleOtto,
    );
    expect(missed?.getUTCSeconds()).toBe(0);
    expect(missed?.getUTCMilliseconds()).toBe(0);
  });
});
