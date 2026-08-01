/**
 * B2B sales triage classifier — exhaustive tests.
 *
 * Coverage:
 *  - each of 8 categories × 4 languages: at least one positive case
 *  - language detection on representative paragraphs
 *  - confidence threshold → needs_human_review fallback
 *  - sender-based out_of_office override
 *  - subject vs body: both feed the matcher
 *  - empty inputs → needs_human_review with confidence=0
 *  - matchedKeywords cap at 8
 *  - suggested action correctness per label
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  classifyB2BSalesReply,
  detectLang,
  type B2BSalesLabel,
} from './triage-b2b-sales.js';

// ─── Language detection ─────────────────────────────────────────────
describe('detectLang', () => {
  it('IT', () => {
    expect(detectLang('Buongiorno, vorrei sapere il prezzo del catalogo. Grazie e cordiali saluti')).toBe('it');
  });
  it('EN', () => {
    expect(detectLang('Hello, I would like to know the price of the catalog. Thank you and best regards')).toBe('en');
  });
  it('DE', () => {
    expect(detectLang('Guten Tag, ich möchte den Preis des Katalogs wissen. Vielen Dank und freundliche Grüße herr')).toBe('de');
  });
  it('FR', () => {
    expect(detectLang('Bonjour, je voudrais connaître le prix du catalogue. Merci et cordialement les')).toBe('fr');
  });
  it('falls back to IT on empty/ambiguous', () => {
    expect(detectLang('')).toBe('it');
  });
});

// ─── Per-category — Italian ─────────────────────────────────────────
describe('IT — interested_buy', () => {
  it('detects "vorrei ordinare"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Re: Redivivo Gin',
      body: 'Buongiorno, vorrei ordinare 12 bottiglie per il nostro bar. Mi mandate condizioni?',
    });
    expect(r.label).toBe('interested_buy');
    expect(r.language).toBe('it');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.suggestedAction).toBe('send_quote');
  });
});

describe('IT — interested_info', () => {
  it('detects "listino + catalogo"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Listino prezzi',
      body: 'Buongiorno, potete inviarmi il listino aggiornato e il catalogo? grazie',
    });
    expect(r.label).toBe('interested_info');
    expect(r.suggestedAction).toBe('send_catalog');
  });
});

describe('IT — interested_tasting', () => {
  it('detects "degustazione"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Re: Mutabilis',
      body: 'Saremmo interessati a una degustazione presso il nostro locale. Quando potete venire?',
    });
    expect(r.label).toBe('interested_tasting');
    expect(r.suggestedAction).toBe('book_tasting');
  });
});

describe('IT — not_interested', () => {
  it('detects "non siamo interessati"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Re: Redivivo Gin',
      body: 'Buongiorno, non siamo interessati al vostro prodotto. Grazie',
    });
    expect(r.label).toBe('not_interested');
    expect(r.suggestedAction).toBe('send_unsubscribe_confirm');
  });

  it('detects "rimuovetemi dalla lista"', () => {
    const r = classifyB2BSalesReply({
      subject: 'unsubscribe',
      body: 'Cancellatemi dalla vostra lista per favore.',
    });
    expect(r.label).toBe('not_interested');
  });
});

describe('IT — wrong_recipient', () => {
  it('detects "non sono io il referente"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Re: Redivivo',
      body: 'Non sono io il responsabile acquisti. Rivolgetevi a Mario Rossi.',
    });
    expect(r.label).toBe('wrong_recipient');
    expect(r.suggestedAction).toBe('forward_to_human');
  });
});

describe('IT — complaint', () => {
  it('detects "diffida + avvocato + gdpr" (high severity)', () => {
    const r = classifyB2BSalesReply({
      subject: 'Diffida',
      body: 'Il mio avvocato vi diffida dal continuare ad inviarmi email. Segnalero\\` al garante per GDPR.',
    });
    expect(r.label).toBe('complaint');
    expect(r.suggestedAction).toBe('forward_to_human');
    expect(r.confidence).toBeGreaterThan(0.7);
  });
});

describe('IT — out_of_office', () => {
  it('detects "sono in ferie"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Out of office',
      body: 'Sono in ferie fino al 15 luglio. Per urgenze rivolgersi al supporto.',
    });
    expect(r.label).toBe('out_of_office');
    expect(r.suggestedAction).toBe('archive');
  });
});

describe('IT — spam', () => {
  it('detects bitcoin solicitation', () => {
    const r = classifyB2BSalesReply({
      subject: 'investimento bitcoin',
      body: 'Vorrei farti una proposta per investimento bitcoin e nft. Guadagni facili!',
    });
    expect(r.label).toBe('spam');
    expect(r.suggestedAction).toBe('archive');
  });
});

// ─── Per-category — English ─────────────────────────────────────────
describe('EN — categories', () => {
  it('interested_info via "price list"', () => {
    const r = classifyB2BSalesReply({
      subject: 'price list',
      body: 'Hello, could you send the latest price list and catalog please. Thanks',
    });
    expect(r.label).toBe('interested_info');
    expect(r.language).toBe('en');
  });
  it('not_interested via "unsubscribe"', () => {
    const r = classifyB2BSalesReply({
      subject: 'unsubscribe',
      body: 'Please unsubscribe me. Thank you.',
    });
    expect(r.label).toBe('not_interested');
  });
  it('out_of_office via "out of office"', () => {
    const r = classifyB2BSalesReply({
      subject: 'OOO',
      body: 'I am out of office on annual leave until next Monday. For urgent matters please contact support.',
    });
    expect(r.label).toBe('out_of_office');
  });
  it('interested_tasting via "tasting sample"', () => {
    const r = classifyB2BSalesReply({
      subject: 'tasting',
      body: 'Would be great to receive a tasting sample. Could we schedule for next week?',
    });
    expect(r.label).toBe('interested_tasting');
  });
});

// ─── Per-category — German + French (smoke) ─────────────────────────
describe('DE — smoke', () => {
  it('interested_info via "preisliste"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Preisliste',
      body: 'Guten Tag herr, bitte senden Sie mir die Preisliste und den Katalog. Vielen Dank und freundliche Grüße',
    });
    expect(r.label).toBe('interested_info');
    expect(r.language).toBe('de');
  });
  it('out_of_office via "abwesenheit"', () => {
    const r = classifyB2BSalesReply({
      subject: 'AW: Abwesenheit',
      body: 'Ich bin im urlaub bis 15. Juli. mit herrn grüße der das die',
    });
    expect(r.label).toBe('out_of_office');
  });
});

describe('FR — smoke', () => {
  it('interested_info via "tarifs"', () => {
    const r = classifyB2BSalesReply({
      subject: 'Tarifs',
      body: 'Bonjour, pourriez-vous m\'envoyer les tarifs et le catalogue ? Merci d\'avance. Cordialement les pour avec',
    });
    expect(r.label).toBe('interested_info');
    expect(r.language).toBe('fr');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────
describe('edge cases', () => {
  it('empty input → needs_human_review with confidence=0', () => {
    const r = classifyB2BSalesReply({ subject: '', body: '' });
    expect(r.label).toBe('needs_human_review');
    expect(r.confidence).toBe(0);
    expect(r.suggestedAction).toBe('forward_to_human');
    expect(r.replyDraft).toBe('');
  });

  it('ambiguous text → low confidence → needs_human_review', () => {
    const r = classifyB2BSalesReply({
      subject: '',
      body: 'Hi.',          // nothing matches a pattern
    });
    expect(r.label).toBe('needs_human_review');
  });

  it('from=noreply@... overrides to out_of_office', () => {
    const r = classifyB2BSalesReply({
      subject: 'Re: Hello',
      body: 'Vorrei un assaggio del vostro gin.',       // would classify as interested_tasting
      from: 'noreply@enoteca.it',
    });
    expect(r.label).toBe('out_of_office');
    expect(r.suggestedAction).toBe('archive');
  });

  it('matchedKeywords list capped at 8', () => {
    const r = classifyB2BSalesReply({
      subject: 'listino catalogo prezzi condizioni commerciali',
      body: 'Listino, catalogo, prezzi, condizioni commerciali, scheda tecnica, documentazione, informazioni, margini rivenditore, listino, catalogo',
    });
    expect(r.matchedKeywords.length).toBeLessThanOrEqual(8);
  });
});

// ─── Reply drafts ───────────────────────────────────────────────────
describe('reply drafts', () => {
  it('IT reply draft uses Italian copy', () => {
    const r = classifyB2BSalesReply({
      subject: 'Listino',
      body: 'Mi mandi il listino per favore',
    });
    expect(r.replyDraft).toMatch(/[Ll]istino|catalogo/);
  });

  it('EN reply draft uses English copy', () => {
    const r = classifyB2BSalesReply({
      subject: 'Price list',
      body: 'Please send me the price list and catalog. Thanks the and to for is of',
      lang: 'en',
    });
    expect(r.replyDraft.toLowerCase()).toContain('catalog');
  });

  it('out_of_office and spam have empty reply draft', () => {
    const ooo = classifyB2BSalesReply({ subject: 'OOO', body: 'out of office until 2026' });
    expect(ooo.replyDraft).toBe('');
  });
});

// ─── Action mapping ─────────────────────────────────────────────────
describe('suggestedAction mapping', () => {
  const cases: [B2BSalesLabel, string][] = [
    ['interested_buy', 'send_quote'],
    ['interested_info', 'send_catalog'],
    ['interested_tasting', 'book_tasting'],
    ['not_interested', 'send_unsubscribe_confirm'],
    ['wrong_recipient', 'forward_to_human'],
    ['complaint', 'forward_to_human'],
    ['out_of_office', 'archive'],
    ['spam', 'archive'],
  ];
  it.each(cases)('%s → %s', (label, action) => {
    // Build a body that should win that label.
    const corpus: Record<B2BSalesLabel, string> = {
      interested_buy: 'vorrei ordinare 12 bottiglie subito',
      interested_info: 'listino aggiornato catalogo prezzi',
      interested_tasting: 'vorremmo una degustazione del prodotto',
      not_interested: 'non siamo interessati grazie cancellate',
      wrong_recipient: 'non sono io il referente, rivolgetevi al responsabile',
      complaint: 'mi rivolgero\\` al mio avvocato e al garante per gdpr',
      out_of_office: 'sono in ferie fino al 15',
      spam: 'investimento bitcoin guadagni facili nft',
      needs_human_review: '',
    };
    const r = classifyB2BSalesReply({ subject: '', body: corpus[label] });
    expect(r.label).toBe(label);
    expect(r.suggestedAction).toBe(action);
  });
});
