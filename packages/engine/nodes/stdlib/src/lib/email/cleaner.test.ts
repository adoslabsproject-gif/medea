/**
 * Test del cleaner email.
 *
 * Copre i 5 strippers individualmente + integrazione + edge:
 *  • quoted reply EN / IT / forwarded / ">" run-of-4
 *  • signature RFC-3676 / mobile / generic-contact
 *  • disclaimer EN / IT / multipli paragrafi
 *  • tracking URL replace + count
 *  • truncation maxBodyLength
 *  • empty / null body
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  cleanEmailBody,
  stripQuotedReply,
  stripSignature,
  stripDisclaimers,
  stripTrackingUrls,
} from './cleaner.js';

describe('stripQuotedReply', () => {
  it('cuts at "On … wrote:" (EN)', () => {
    const body = 'Hi, here\'s the doc.\n\nOn 2026-01-15 14:32, Mario Rossi wrote:\n> previous line';
    expect(stripQuotedReply(body)).toBe("Hi, here's the doc.");
  });

  it('cuts at "Il giorno … ha scritto:" (IT)', () => {
    const body = 'Ciao Mario,\n\nIl giorno 15 gennaio 2026 14:32, Anna Bianchi ha scritto:\n> Buongiorno';
    expect(stripQuotedReply(body)).toBe('Ciao Mario,');
  });

  it('cuts at "----- Forwarded message -----"', () => {
    const body = 'FYI\n\n---------- Forwarded message ----------\nFrom: x@y.com';
    expect(stripQuotedReply(body)).toBe('FYI');
  });

  it('cuts at 4+ consecutive ">" lines without divider', () => {
    const body = 'Reply\n\n> q1\n> q2\n> q3\n> q4\n> q5';
    expect(stripQuotedReply(body)).toBe('Reply');
  });

  it('does NOT cut on single isolated ">" lines (regular punctuation)', () => {
    const body = 'Vediamoci alle 15>16, anche dopo va bene.';
    expect(stripQuotedReply(body)).toBe(body);
  });

  it('cuts at "Da:" Outlook IT header', () => {
    const body = 'Buongiorno.\n\nDa: cliente@x.it\nA: studio@y.it';
    expect(stripQuotedReply(body)).toBe('Buongiorno.');
  });

  // ── Anti-ReDoS: le pattern divider ambigue `.{4,80},?\s*.{1,80}\s+` backtrack-avano
  // ~250ms/riga ANCHE col cap a 256 → DoS-per-volume (256KB ≈ 1000 righe = ~250s). Fix
  // VERO: regex LINEARE (un solo `[^\n]{4,140}` + àncora) → costo per-riga O(len), niente
  // esplosione. Questo test prova lo scenario by-VOLUME, non la singola riga.
  it('🚨 by-VOLUME: 2000 righe ostili "on …" senza match → totale << 1s (regex lineare)', () => {
    // Ogni riga è al limite del cap, senza " wrote:" finale → forza il backtracking che
    // col vecchio codice era ~250ms CIASCUNA. Lineare ⇒ l'intero body è veloce.
    const hostileLine = 'on ' + 'a, '.repeat(60).trim(); // ~180 char, sotto il cap, no "wrote:"
    const body = Array.from({ length: 2000 }, () => hostileLine).join('\n');
    const t0 = performance.now();
    const out = stripQuotedReply(body);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1000); // 2000 × O(len) ~ pochi ms; col vecchio: ~minuti
    expect(out).toBe(body); // nessuna riga è un divider → nessun taglio
  });

  it('🚨 riga oltre il cap → scartata subito (difesa-in-profondità), non è divider', () => {
    const body = 'Testo.\n' + 'on ' + 'a '.repeat(40000) + '\nAltro.';
    const t0 = performance.now();
    const out = stripQuotedReply(body);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toBe(body);
  });

  it('anti-regressione: i divider reali (EN/IT) continuano a tagliare dopo la riscrittura', () => {
    expect(stripQuotedReply('Ciao.\n\nOn 2026-01-15 14:32, Mario Rossi wrote:\n> q')).toBe('Ciao.');
    expect(stripQuotedReply('Salve.\n\nIl giorno 15 gennaio 2026, Anna ha scritto:\n> q')).toBe('Salve.');
    // Divider lungo ma plausibile (< 140 char nel gruppo) → ancora riconosciuto.
    const body = 'Ciao.\n\nOn 2026-01-15 14:32, ' + 'Mario Rossi '.repeat(5).trim() + ' wrote:\n> quoted';
    expect(stripQuotedReply(body)).toBe('Ciao.');
  });
});

describe('stripSignature', () => {
  it('strips RFC-3676 "-- " delimiter and following block', () => {
    const body = 'Saluti\n-- \nMario Rossi\nStudio Rossi\nVia X 12';
    expect(stripSignature(body)).toBe('Saluti');
  });

  it('strips "Inviato dal mio iPhone"', () => {
    const body = 'Va bene grazie.\n\nInviato dal mio iPhone';
    expect(stripSignature(body)).toBe('Va bene grazie.');
  });

  it('strips "Sent from my iPhone"', () => {
    const body = 'Thanks.\n\nSent from my iPhone';
    expect(stripSignature(body)).toBe('Thanks.');
  });

  it('strips generic contact-line block at end', () => {
    const body = 'Saluti\n\nMario Rossi\nTel: 333 1234567\nP.IVA: 12345678901';
    expect(stripSignature(body)).toBe('Saluti');
  });

  it('does NOT strip when "Tel:" appears inside the message body', () => {
    const body = 'Mi puoi chiamare al numero? Tel: 333 1234567\nPoi parliamo.';
    // The contact line is NOT at the end → don't touch.
    expect(stripSignature(body)).toBe(body);
  });
});

describe('stripDisclaimers', () => {
  it('drops EN confidentiality boilerplate', () => {
    const body = 'Hi.\n\nThis email and any attachments are confidential and intended solely for the addressee.\n\nThanks.';
    expect(stripDisclaimers(body)).toBe('Hi.\n\nThanks.');
  });

  it('drops IT "Le informazioni contenute"', () => {
    const body = 'Buongiorno.\n\nLe informazioni contenute nel presente messaggio sono riservate.\n\nGrazie.';
    expect(stripDisclaimers(body)).toBe('Buongiorno.\n\nGrazie.');
  });

  it('drops eco-disclaimer "Per proteggere l\'ambiente"', () => {
    const body = 'Saluti.\n\nPer proteggere l\'ambiente non stampare questo messaggio se non strettamente necessario.';
    expect(stripDisclaimers(body)).toBe('Saluti.');
  });

  it('keeps body when no pattern matches', () => {
    const body = 'Solo testo normale, nessun disclaimer.';
    expect(stripDisclaimers(body)).toBe(body);
  });
});

describe('stripTrackingUrls', () => {
  it('replaces UTM-tagged URL with the bare domain', () => {
    const r = stripTrackingUrls('Visita https://example.com/p?utm_source=a&utm_campaign=b');
    expect(r.text).toBe('Visita https://example.com/');
    expect(r.replaced).toBe(1);
  });

  it('leaves clean URLs untouched', () => {
    const r = stripTrackingUrls('Apri https://example.com/page');
    expect(r.text).toBe('Apri https://example.com/page');
    expect(r.replaced).toBe(0);
  });

  it('replaces gclid / fbclid params', () => {
    const r = stripTrackingUrls('https://x.com?gclid=ABC https://y.com?fbclid=XYZ');
    expect(r.replaced).toBe(2);
  });
});

describe('cleanEmailBody — integration', () => {
  it('drops quoted reply + signature + disclaimer in a real-world body', () => {
    const body = [
      'Buongiorno,',
      'vi mando i documenti per il 730.',
      'Grazie. Mario.',
      '',
      '-- ',
      'Mario Rossi',
      'Tel: 333 1234567',
      '',
      'Le informazioni contenute nel presente messaggio sono riservate.',
      '',
      'Il giorno 15 gennaio 2026 14:32, Anna Bianchi ha scritto:',
      '> Buongiorno Mario,',
      '> ti chiedo cortesemente la dichiarazione 2025.',
    ].join('\n');

    const r = cleanEmailBody(body);
    expect(r.removedQuotedReply).toBe(true);
    expect(r.removedSignature).toBe(true);
    // Note: the disclaimer was inside the signature block, so it was removed
    // by the signature stripper before the disclaimer stripper saw it. That's
    // intentional — the order in `cleanEmailBody` is quoted→sig→disclaimer.
    expect(r.cleanedBody).toContain('730');
    expect(r.cleanedBody).not.toContain('Inviato');
    expect(r.cleanedBody).not.toContain('Anna Bianchi ha scritto');
    expect(r.cleanedLength).toBeLessThan(r.originalLength);
    expect(r.reductionRatio).toBeLessThan(0.5);
  });

  it('truncates at maxBodyLength with ellipsis', () => {
    const body = 'a'.repeat(10_000);
    const r = cleanEmailBody(body, { maxBodyLength: 100 });
    expect(r.cleanedBody.length).toBe(101);  // 100 chars + …
    expect(r.cleanedBody.endsWith('…')).toBe(true);
  });

  it('returns empty result on empty input', () => {
    const r = cleanEmailBody('');
    expect(r.cleanedBody).toBe('');
    expect(r.reductionRatio).toBe(1);
    expect(r.originalLength).toBe(0);
  });

  it('collapses 4+ blank lines to a single blank when enabled', () => {
    const r = cleanEmailBody('para1\n\n\n\n\npara2');
    expect(r.cleanedBody).toBe('para1\n\npara2');
  });

  it('respects stripQuotedReply=false flag', () => {
    const body = 'Reply\n\nOn 2026-01-15, X wrote:\n> q';
    const r = cleanEmailBody(body, { stripQuotedReply: false });
    expect(r.removedQuotedReply).toBe(false);
    expect(r.cleanedBody).toContain('On 2026-01-15');
  });
});
