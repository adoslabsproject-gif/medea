/**
 * Test 2026-grade — email-harvest.service.ts (multi-strategy email extraction).
 *
 * 🚨 BUSINESS-CRITICAL: lead-gen workflow. False positive (noreply@ catturato) →
 * email spam al sistema; false negative (mailto skipped) → lead perso.
 *
 * Coverage 5 strategies:
 *  - mailto: links (confidence 100) — anche con ?subject= query string
 *  - Cloudflare Email Protection decoder (XOR-hex) confidence 95
 *  - HTML entity decoder (&#64;, &commat;, &#46;) confidence 90
 *  - Plain regex RFC-5322-lite confidence 80
 *  - Text obfuscation [at]/[dot]/AT/(@)/etc. confidence 70
 *
 * 🚨 Noise filter:
 *  - NOISE_LOCAL_PARTS: noreply, postmaster, test, example, ...
 *  - NOISE_DOMAINS: example.com, sample.com, mydomain.com, localhost...
 *  - NOISE_TLD_SUFFIXES: .example, .test, .invalid, .localhost, .local
 *  - TLD lunghezza < 2 o > 24 → filtered
 *  - Local part troppo corto → filtered
 *
 * 🚨 Primary email selection:
 *  - commerciale > info > contact > admin > altri
 *  - confidence + prioBonus → score finale
 *
 * 🚨 Robustness:
 *  - HTML invalido (cheerio throw) → fallback regex su raw
 *  - script/style/iframe rimossi prima del text extract
 *  - dedup case-insensitive con highest confidence wins
 */
import { describe, it, expect } from 'vitest';
import { harvestEmails } from './email-harvest.service.js';

/**
 * Encode una email in Cloudflare hex format.
 * Primo byte = chiave XOR, restanti bytes = char ^ key.
 */
function encodeCloudflare(email: string, key = 0x2a): string {
  const bytes = [key];
  for (const ch of email) {
    bytes.push(ch.charCodeAt(0) ^ key);
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('empty / minimal HTML', () => {
  it('empty html → no emails + tutti counter 0', () => {
    const r = harvestEmails('');
    expect(r.primary_email).toBeNull();
    expect(r.all_emails).toEqual([]);
    expect(r.counts.mailto).toBe(0);
    expect(r.counts.plain_text).toBe(0);
    expect(r.counts.filtered_noise).toBe(0);
  });

  it('html senza email → all_emails vuoto', () => {
    const r = harvestEmails('<html><body><p>nothing here</p></body></html>');
    expect(r.all_emails).toHaveLength(0);
  });
});

describe('🚨 Strategy 1: mailto links', () => {
  it('🚨 mailto href → confidence 100, source mailto', () => {
    const r = harvestEmails('<a href="mailto:sales@acme.com">Sales</a>');
    expect(r.all_emails).toHaveLength(1);
    expect(r.all_emails[0]).toEqual({
      email: 'sales@acme.com', confidence: 100, source: 'mailto',
    });
    expect(r.counts.mailto).toBe(1);
  });

  it('mailto con query (?subject=) → email pulita senza query', () => {
    const r = harvestEmails('<a href="mailto:info@acme.com?subject=Hello&body=text">Contact</a>');
    expect(r.all_emails[0]?.email).toBe('info@acme.com');
  });

  it('🚨 GAP del source: selector "[href^=mailto:]" case-SENSITIVE — MAILTO: NON matcha', () => {
    // Documenta il gap: cheerio attribute selector è case-sensitive, quindi
    // href="MAILTO:..." NON viene processato come mailto strategy. Inoltre
    // l'email nell'attribute href NON appare nel body.text() (solo il
    // contenuto visible "x") → NESSUNA strategia la trova.
    const r = harvestEmails('<a href="MAILTO:sales@acme.com">x</a>');
    expect(r.all_emails).toHaveLength(0);
    expect(r.counts.mailto).toBe(0);
  });

  it('mailto VUOTO (mailto:) → niente aggiunto', () => {
    const r = harvestEmails('<a href="mailto:">No email</a>');
    expect(r.all_emails).toHaveLength(0);
  });

  it('multipli mailto link → tutti raccolti', () => {
    const r = harvestEmails(`
      <a href="mailto:sales@acme.com">Sales</a>
      <a href="mailto:support@acme.com">Support</a>
    `);
    expect(r.all_emails).toHaveLength(2);
    expect(r.counts.mailto).toBe(2);
  });
});

describe('🚨 Strategy 2: Cloudflare Email Protection decoder', () => {
  it('🚨 data-cfemail attribute → XOR decode con primo byte = key', () => {
    const encoded = encodeCloudflare('hello@acme.com', 0x42);
    const r = harvestEmails(`<a class="__cf_email__" data-cfemail="${encoded}">[email protected]</a>`);
    const email = r.all_emails.find((e) => e.email === 'hello@acme.com');
    expect(email?.confidence).toBe(95);
    expect(email?.source).toBe('cloudflare');
    expect(r.counts.cloudflare).toBeGreaterThan(0);
  });

  it('🚨 data-cfemail con key diversa (0xff) → still decode', () => {
    const encoded = encodeCloudflare('a@b.co', 0xff);
    const r = harvestEmails(`<span data-cfemail="${encoded}"></span>`);
    const email = r.all_emails.find((e) => e.email === 'a@b.co');
    expect(email?.confidence).toBe(95);
  });

  it('🚨 invalid hex (lunghezza dispari) → skip silently', () => {
    const r = harvestEmails('<span data-cfemail="abc"></span>');
    expect(r.counts.cloudflare).toBe(0);
  });

  it('🚨 hex troppo corto (< 4 char) → null', () => {
    const r = harvestEmails('<span data-cfemail="ab"></span>');
    expect(r.counts.cloudflare).toBe(0);
  });

  it('🚨 hex decoded NON pattern email → null (validation post-decode)', () => {
    // encoded = key + bytes che NON sono "x@y.zz"
    const hex = encodeCloudflare('nothing-special-here', 0x42);
    const r = harvestEmails(`<span data-cfemail="${hex}"></span>`);
    // decoded = "nothing-special-here" → NO @ → fallisce validation
    const cf = r.all_emails.find((e) => e.source === 'cloudflare');
    expect(cf).toBeUndefined();
  });
});

describe('🚨 Strategy 3: HTML entity decoder', () => {
  // NOTA: cheerio normalizza le entity HTML in .text() PRIMA del manual decode
  // del source. Quindi nel testo già decodato l'email risulta come plain-text
  // (text.includes(m) === true) → source='plain-text', confidence 80.
  // Il branch html-entity con confidence 90 è raggiungibile SOLO quando cheerio
  // NON decoda l'entity (edge case). Documento il comportamento reale.

  it('🚨 &#64; (decimal @) → cheerio decoda → resta plain-text confidence 80', () => {
    const r = harvestEmails('<p>contact: info&#64;acme.com</p>');
    const e = r.all_emails.find((x) => x.email === 'info@acme.com');
    expect(e?.confidence).toBe(80);
    expect(e?.source).toBe('plain-text');
  });

  it('&commat; → @ decoded (named entity)', () => {
    const r = harvestEmails('<p>info&commat;acme.com</p>');
    expect(r.all_emails[0]?.email).toBe('info@acme.com');
  });

  it('&#46; (decimal .) decoded — combinato con &#64;', () => {
    const r = harvestEmails('<p>info&#64;acme&#46;com</p>');
    expect(r.all_emails[0]?.email).toBe('info@acme.com');
  });

  it('&#x40; (hex @) decoded', () => {
    const r = harvestEmails('<p>info&#x40;acme.com</p>');
    expect(r.all_emails[0]?.email).toBe('info@acme.com');
  });
});

describe('🚨 Strategy 4: plain regex', () => {
  it('🚨 plain text email → confidence 80', () => {
    const r = harvestEmails('<p>Contattaci a info@acme.com per info</p>');
    expect(r.all_emails[0]?.confidence).toBe(80);
    expect(r.all_emails[0]?.source).toBe('plain-text');
  });

  it('plain regex cattura multiple', () => {
    const r = harvestEmails('<p>info@a.com, sales@b.org, support@c.net</p>');
    expect(r.all_emails).toHaveLength(3);
  });

  it('🚨 regex BOUNDED su valid TLD (rifiuta typo .x)', () => {
    const r = harvestEmails('<p>typo@example.x</p>');
    // TLD 1 char → regex {2,} non matcha
    expect(r.all_emails).toHaveLength(0);
  });

  it('Subdomain multipli (a.b.c.com) supportato dal regex', () => {
    // NOTA: "name" è in NOISE_LOCAL_PARTS → filtered. Uso "sales" che NON è noise.
    const r = harvestEmails('<p>sales@mail.sub.acme.com</p>');
    expect(r.all_emails[0]?.email).toBe('sales@mail.sub.acme.com');
  });

  it('🚨 local "name" è NOISE (placeholder) → filtered anche con domain valido', () => {
    const r = harvestEmails('<p>name@mail.sub.acme.com</p>');
    expect(r.all_emails).toHaveLength(0);
    expect(r.counts.filtered_noise).toBe(1);
  });
});

describe('🚨 Strategy 5: text obfuscation', () => {
  it('🚨 "info [at] acme [dot] com" → decoded', () => {
    const r = harvestEmails('<p>email: info [at] acme [dot] com</p>');
    const e = r.all_emails.find((x) => x.email === 'info@acme.com');
    expect(e?.confidence).toBe(70);
    expect(e?.source).toBe('obfuscated');
  });

  it('"info AT acme DOT com" (caps) → decoded', () => {
    const r = harvestEmails('<p>info AT acme DOT com</p>');
    expect(r.all_emails.find((e) => e.email === 'info@acme.com')).toBeDefined();
  });

  it('"info (@) acme (.) com" → decoded', () => {
    const r = harvestEmails('<p>info (@) acme (.) com</p>');
    expect(r.all_emails.find((e) => e.email === 'info@acme.com')).toBeDefined();
  });

  it('"info {at} acme {dot} com" (graffe) → decoded', () => {
    const r = harvestEmails('<p>info {at} acme {dot} com</p>');
    expect(r.all_emails.find((e) => e.email === 'info@acme.com')).toBeDefined();
  });

  it('🚨 lowercase AT/dot dentro testo normale NON deve far false positive', () => {
    // "at" lowercase NON in [brackets] non triggera
    const r = harvestEmails('<p>I will be there at home dot soon</p>');
    expect(r.all_emails).toHaveLength(0);
  });
});

describe('🚨 NOISE filter (RFC 2606 + conventions)', () => {
  it('🚨 noreply@ → filtered', () => {
    const r = harvestEmails('<a href="mailto:noreply@acme.com">x</a>');
    expect(r.all_emails).toHaveLength(0);
    expect(r.counts.filtered_noise).toBe(1);
  });

  it('🚨 do-not-reply@ → filtered', () => {
    const r = harvestEmails('<a href="mailto:do-not-reply@acme.com">x</a>');
    expect(r.all_emails).toHaveLength(0);
  });

  it('🚨 postmaster@ filtered', () => {
    const r = harvestEmails('<a href="mailto:postmaster@acme.com">x</a>');
    expect(r.all_emails).toHaveLength(0);
  });

  it('🚨 test@ / example@ filtered (placeholder)', () => {
    const r1 = harvestEmails('<a href="mailto:test@acme.com">x</a>');
    const r2 = harvestEmails('<a href="mailto:example@acme.com">x</a>');
    expect(r1.all_emails).toHaveLength(0);
    expect(r2.all_emails).toHaveLength(0);
  });

  it('🚨 domain example.com → filtered (RFC 2606)', () => {
    const r = harvestEmails('<a href="mailto:user@example.com">x</a>');
    expect(r.all_emails).toHaveLength(0);
  });

  it('🚨 TLD .test/.invalid/.localhost → filtered (RFC 2606)', () => {
    const r1 = harvestEmails('<a href="mailto:info@acme.test">x</a>');
    const r2 = harvestEmails('<a href="mailto:info@acme.invalid">x</a>');
    const r3 = harvestEmails('<a href="mailto:info@acme.localhost">x</a>');
    expect(r1.all_emails).toHaveLength(0);
    expect(r2.all_emails).toHaveLength(0);
    expect(r3.all_emails).toHaveLength(0);
  });

  it('🚨 TLD lunghezza > 24 → filtered (typo defense)', () => {
    const r = harvestEmails('<a href="mailto:info@acme.thistldistoolongtoberealxxx">x</a>');
    expect(r.all_emails).toHaveLength(0);
  });

  it('mydomain.com / your-domain.com → filtered (placeholder)', () => {
    expect(harvestEmails('<a href="mailto:x@mydomain.com">x</a>').all_emails).toHaveLength(0);
    expect(harvestEmails('<a href="mailto:x@your-domain.com">x</a>').all_emails).toHaveLength(0);
  });

  it('🚨 NORMAL email (sales@acme.com) NON filtered', () => {
    const r = harvestEmails('<a href="mailto:sales@acme.com">x</a>');
    expect(r.all_emails).toHaveLength(1);
    expect(r.counts.filtered_noise).toBe(0);
  });
});

describe('🚨 dedup case-insensitive + highest confidence wins', () => {
  it('🚨 stessa email da mailto (100) + plain text (80) → solo 1, confidence 100', () => {
    const html = '<a href="mailto:info@acme.com">link</a><p>info@acme.com text</p>';
    const r = harvestEmails(html);
    const matches = r.all_emails.filter((e) => e.email === 'info@acme.com');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe(100);
    expect(matches[0]?.source).toBe('mailto');
  });

  it('🚨 stessa email con casing diverso → unica (lowercase)', () => {
    const html = '<a href="mailto:INFO@acme.com">x</a><p>Info@Acme.com</p>';
    const r = harvestEmails(html);
    const filtered = r.all_emails.filter((e) => e.email === 'info@acme.com');
    expect(filtered).toHaveLength(1);
  });

  it('🚨 sort by confidence DESC', () => {
    const html = `
      <a href="mailto:high@acme.com">100</a>
      <p>plain@acme.com</p>
    `;
    const r = harvestEmails(html);
    expect(r.all_emails[0]?.confidence).toBeGreaterThanOrEqual(r.all_emails[1]?.confidence ?? 0);
  });
});

describe('🚨 primary_email — selection priority', () => {
  it('🚨 commerciale@ vince su info@', () => {
    const r = harvestEmails(`
      <a href="mailto:info@acme.com">info</a>
      <a href="mailto:commerciale@acme.com">comm</a>
    `);
    expect(r.primary_email).toBe('commerciale@acme.com');
  });

  it('🚨 info@ vince su admin@', () => {
    const r = harvestEmails(`
      <a href="mailto:admin@acme.com">a</a>
      <a href="mailto:info@acme.com">i</a>
    `);
    expect(r.primary_email).toBe('info@acme.com');
  });

  it('🚨 commerciale.italia@ matchato come "commerciale" (prefix dot)', () => {
    const r = harvestEmails('<a href="mailto:commerciale.italia@acme.com">x</a>');
    expect(r.primary_email).toBe('commerciale.italia@acme.com');
  });

  it('🚨 contact-us@ matchato come "contact" (prefix dash)', () => {
    const r = harvestEmails('<a href="mailto:contact-us@acme.com">x</a>');
    expect(r.primary_email).toBe('contact-us@acme.com');
  });

  it('🚨 sales@ vince su contact@ (priority più alta)', () => {
    const r = harvestEmails(`
      <a href="mailto:contact@acme.com">c</a>
      <a href="mailto:sales@acme.com">s</a>
    `);
    expect(r.primary_email).toBe('sales@acme.com');
  });

  it('email sconosciuta (random@) → mantiene priority bassa', () => {
    const r = harvestEmails(`
      <a href="mailto:random@acme.com">r</a>
      <a href="mailto:info@acme.com">i</a>
    `);
    expect(r.primary_email).toBe('info@acme.com');
  });

  it('una sola email → quella è primary', () => {
    const r = harvestEmails('<a href="mailto:onething@acme.com">x</a>');
    expect(r.primary_email).toBe('onething@acme.com');
  });

  it('nessuna email → primary_email=null', () => {
    const r = harvestEmails('<p>no email here</p>');
    expect(r.primary_email).toBeNull();
  });
});

describe('🚨 script/style/iframe rimossi prima del text extract', () => {
  it('🚨 email in <script> NON catturata', () => {
    const r = harvestEmails(`
      <body>
        <script>var x = "hidden@acme.com";</script>
      </body>
    `);
    expect(r.all_emails).toHaveLength(0);
  });

  it('🚨 email in <style> NON catturata', () => {
    const r = harvestEmails(`
      <body>
        <style>/* css with hidden@acme.com */</style>
      </body>
    `);
    expect(r.all_emails).toHaveLength(0);
  });

  it('email NEL body resta visibile', () => {
    const r = harvestEmails(`
      <body>
        <script>var x = "hidden@acme.com";</script>
        <p>visible: real@acme.com</p>
      </body>
    `);
    expect(r.all_emails.find((e) => e.email === 'real@acme.com')).toBeDefined();
    expect(r.all_emails.find((e) => e.email === 'hidden@acme.com')).toBeUndefined();
  });
});

describe('🚨 HTML invalido — fallback regex raw', () => {
  it('HTML completamente broken → cheerio comunque parsa, email da regex', () => {
    // cheerio in pratica è tollerante. Anche con questo malformed → estrae.
    const r = harvestEmails('not-html-at-all just-text@acme.com here');
    expect(r.all_emails.find((e) => e.email === 'just-text@acme.com')).toBeDefined();
  });
});

describe('output shape', () => {
  it('HarvestResult include tutti i campi', () => {
    const r = harvestEmails('<a href="mailto:info@acme.com">x</a>');
    expect(r).toMatchObject({
      primary_email: expect.any(String),
      all_emails: expect.any(Array),
      counts: expect.objectContaining({
        mailto: expect.any(Number),
        cloudflare: expect.any(Number),
        html_entity: expect.any(Number),
        plain_text: expect.any(Number),
        obfuscated: expect.any(Number),
        filtered_noise: expect.any(Number),
      }),
    });
  });

  it('HarvestedEmail include email + confidence + source', () => {
    const r = harvestEmails('<a href="mailto:info@acme.com">x</a>');
    expect(r.all_emails[0]).toMatchObject({
      email: expect.any(String),
      confidence: expect.any(Number),
      source: expect.any(String),
    });
  });
});
