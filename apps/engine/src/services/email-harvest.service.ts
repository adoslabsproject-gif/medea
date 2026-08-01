/**
 * Email Harvester — estrazione multi-strategy email da pagine web.
 *
 * STRATEGIE 2026 STATE-OF-THE-ART:
 *
 * 1. mailto: links (cheerio DOM-aware) — confidence 100
 *    Pattern: <a href="mailto:info@example.com">
 *    Tipico: pagina /contatti, footer
 *
 * 2. Cloudflare Email Protection decoder — confidence 95
 *    Pattern: <a class="__cf_email__" data-cfemail="XX..."> dove XX..
 *    è XOR-hex encoding con primo byte come key.
 *    Cloudflare offusca le email per default su molti siti enterprise.
 *
 * 3. HTML entity decoder — confidence 90
 *    Pattern: info&#64;esempio&#46;it, info&commat;esempio.it
 *    Comune su CMS WordPress con plugin anti-spam.
 *
 * 4. Plain regex RFC-5322-lite — confidence 80
 *    Pattern: [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
 *    Cattura email scritte in chiaro (testo, p, span, li).
 *
 * 5. Text obfuscation patterns — confidence 70
 *    Pattern: "info [at] domain [dot] com", "info AT domain DOT com",
 *             "info (@) domain (.) com", "info{at}domain{dot}com"
 *    Anti-spam manuale tipico.
 *
 * NOISE FILTER (post-extraction):
 *   - noreply@/no-reply@/do-not-reply@/donotreply@ (system addresses)
 *   - test@/example@/your-email@ (placeholders)
 *   - *@example.com/.test/.invalid (RFC 2606 reserved)
 *   - *@privacy.example, *@dpo.example (privacy placeholder)
 *   - Empty local part (@domain.com), invalid TLD (length < 2)
 *
 * SELECTION RULE: l'output `primary_email` è scelto con priorità:
 *   commercial@/sales@/info@/contact@ > admin@/staff@/team@ > altro
 *
 * Output: { primary_email, all_emails: [{email, confidence, source}], counts }
 */

import * as cheerio from 'cheerio';

export interface HarvestedEmail {
  email: string;
  /** 0-100: alta = trovata con metodo intenzionale (mailto, decoded), bassa = pattern testuale */
  confidence: number;
  /** Strategia che l'ha trovata, per debug + scoring */
  source: 'mailto' | 'cloudflare' | 'html-entity' | 'plain-text' | 'obfuscated';
}

export interface HarvestResult {
  /** Email primaria scelta secondo priority rule (commercial > admin > generic). null se nessuna trovata. */
  primary_email: string | null;
  /** Tutte le email trovate, dedupplicate per address (lowercase), ordinate per confidence DESC */
  all_emails: HarvestedEmail[];
  /** Conteggi per strategia — utile per debug + analytics */
  counts: {
    mailto: number;
    cloudflare: number;
    html_entity: number;
    plain_text: number;
    obfuscated: number;
    filtered_noise: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Noise patterns (RFC 2606 + commerce conventions)
// ─────────────────────────────────────────────────────────────────────────

const NOISE_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'abuse',
  'test', 'tests', 'testing',
  'example', 'sample', 'demo', 'your-email', 'you', 'name',
  'user', 'username', 'admin@admin',
  'email', 'youremail',
]);

const NOISE_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net',
  'sample.com', 'test.com', 'mydomain.com', 'domain.com',
  'your-domain.com', 'yourdomain.com',
  'localhost.com', 'localhost.localdomain',
]);

const NOISE_TLD_SUFFIXES = ['.example', '.test', '.invalid', '.localhost', '.local'];

// ─────────────────────────────────────────────────────────────────────────
// Priority rule per primary_email selection
// ─────────────────────────────────────────────────────────────────────────

const COMMERCIAL_LOCAL_PARTS = [
  // Massima priorità: commerciale diretto
  'commerciale', 'sales', 'vendite', 'ventas', 'verkauf', 'forsaljning',
  // Alta: punto entrata business
  'info', 'commercial', 'business',
  // Media: contatto generico
  'contact', 'contatti', 'contacto', 'kontakt', 'contattaci',
  // Bassa: dipartimenti tecnici/admin
  'support', 'help', 'assistenza', 'service',
  'admin', 'office', 'team', 'staff', 'hello', 'hi',
];

function priorityOf(localPart: string): number {
  const lower = localPart.toLowerCase();
  const idx = COMMERCIAL_LOCAL_PARTS.findIndex((p) => lower === p || lower.startsWith(`${p}.`) || lower.startsWith(`${p}-`));
  if (idx < 0) return COMMERCIAL_LOCAL_PARTS.length + 1; // unknown, lowest priority
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────
// Email validation (RFC 5322 simplified)
// ─────────────────────────────────────────────────────────────────────────

// Regex RFC-5322-lite. NO Punycode IDN (rare in cold outreach), NO quoted local-part.
const EMAIL_REGEX = /\b([a-zA-Z0-9][a-zA-Z0-9._%+-]{0,63})@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)\b/g;

function isNoise(email: string): boolean {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return true;
  if (NOISE_LOCAL_PARTS.has(local)) return true;
  if (NOISE_DOMAINS.has(domain)) return true;
  if (NOISE_TLD_SUFFIXES.some((suf) => domain.endsWith(suf))) return true;
  // TLD lunghezza minima 2 (es: .it, .com, .org). Filtra typo come info@example.c
  const tld = domain.split('.').pop() ?? '';
  if (tld.length < 2 || tld.length > 24) return true;
  // Local part suspiciously short (1 char) generalmente è placeholder
  if (local.length < 2 && !/^[a-z]$/.test(local)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Decoders
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cloudflare Email Protection decoder.
 * Pattern: <a class="__cf_email__" data-cfemail="98abcd...">[email protected]</a>
 * Decode: il primo byte è la XOR key, gli altri sono i char encoded.
 */
function decodeCloudflareEmail(hexStr: string): string | null {
  try {
    if (hexStr.length < 4 || hexStr.length % 2 !== 0) return null;
    const bytes: number[] = [];
    for (let i = 0; i < hexStr.length; i += 2) {
      bytes.push(parseInt(hexStr.substr(i, 2), 16));
    }
    if (bytes.length < 2) return null;
    const key = bytes[0] ?? 0;
    const decoded = bytes.slice(1).map((b) => String.fromCharCode(b ^ key)).join('');
    // Validazione: deve contenere @
    if (!/^[^@]+@[^@]+\.[a-zA-Z]{2,}$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Pattern obfuscation testuale: info [at] domain [dot] com etc.
 * Tutte le permutazioni comuni: [at], (at), {at}, AT, at, @ wrapped.
 */
function decodeTextObfuscation(text: string): string[] {
  const found = new Set<string>();
  // Pattern: word [at|AT|@] word [dot|DOT|.] tld
  // Note: matching prudente per evitare false positive su testo normale
  const patterns = [
    // info [at] domain [dot] com
    /\b([a-z0-9._%+-]+)\s*[[({]\s*at\s*[\])}]\s*([a-z0-9.-]+)\s*[[({]\s*dot\s*[\])}]\s*([a-z]{2,24})\b/gi,
    // info AT domain DOT com (with caps required to avoid false positive)
    /\b([a-z0-9._%+-]+)\s+AT\s+([a-z0-9.-]+)\s+DOT\s+([a-z]{2,24})\b/g,
    // info (@) domain (.) com
    /\b([a-z0-9._%+-]+)\s*\(@?\)\s*([a-z0-9.-]+)\s*\(\.\)\s*([a-z]{2,24})\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const email = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
      found.add(email);
    }
  }
  return Array.from(found);
}

// ─────────────────────────────────────────────────────────────────────────
// Main harvester
// ─────────────────────────────────────────────────────────────────────────

export function harvestEmails(html: string): HarvestResult {
  const result: HarvestResult = {
    primary_email: null,
    all_emails: [],
    counts: { mailto: 0, cloudflare: 0, html_entity: 0, plain_text: 0, obfuscated: 0, filtered_noise: 0 },
  };

  // Map dedup per email (lowercase) → highest confidence sighting
  const seen = new Map<string, HarvestedEmail>();
  const add = (email: string, confidence: number, source: HarvestedEmail['source']): void => {
    const lower = email.toLowerCase().trim();
    if (isNoise(lower)) {
      result.counts.filtered_noise++;
      return;
    }
    const existing = seen.get(lower);
    if (!existing || confidence > existing.confidence) {
      seen.set(lower, { email: lower, confidence, source });
    }
  };

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    // HTML invalido → fallback solo regex su raw text
    const m = html.match(EMAIL_REGEX);
    if (m) for (const e of m) add(e, 80, 'plain-text');
    result.all_emails = Array.from(seen.values()).sort((a, b) => b.confidence - a.confidence);
    return result;
  }

  // === Strategy 1: mailto: links (confidence 100) ===
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const email = href.replace(/^mailto:/i, '').split('?')[0]?.trim();
    if (email) {
      add(email, 100, 'mailto');
      result.counts.mailto++;
    }
  });

  // === Strategy 2: Cloudflare email protection ===
  $('[data-cfemail]').each((_, el) => {
    const hex = $(el).attr('data-cfemail') ?? '';
    const decoded = decodeCloudflareEmail(hex);
    if (decoded) {
      add(decoded, 95, 'cloudflare');
      result.counts.cloudflare++;
    }
  });
  // Cloudflare a volte mette il data attribute su href stesso
  $('a.__cf_email__').each((_, el) => {
    const hex = $(el).attr('data-cfemail') ?? '';
    const decoded = decodeCloudflareEmail(hex);
    if (decoded) {
      add(decoded, 95, 'cloudflare');
      result.counts.cloudflare++;
    }
  });

  // === Strategy 3: HTML entities (decode + regex) ===
  // cheerio gestisce automaticamente entities nel .text(), quindi extract text
  // dopo strip script/style + regex su quello.
  $('script, style, noscript, iframe').remove();
  const text = $('body').text() || $.root().text() || '';
  // Decode delle entity comuni (numeric + named)
  const decoded = text
    .replace(/&#64;|&#x40;|&commat;/gi, '@')
    .replace(/&#46;|&#x2e;|&period;/gi, '.');

  // === Strategy 4: Plain regex su testo decoded ===
  const matches = decoded.match(EMAIL_REGEX);
  if (matches) {
    for (const m of matches) {
      // Distingui plain vs entity-decoded: se nel raw text non c'era ma nel decoded sì → entity
      const inRaw = text.includes(m);
      add(m, inRaw ? 80 : 90, inRaw ? 'plain-text' : 'html-entity');
      if (inRaw) result.counts.plain_text++;
      else result.counts.html_entity++;
    }
  }

  // === Strategy 5: text obfuscation ===
  const obfuscated = decodeTextObfuscation(text);
  for (const e of obfuscated) {
    add(e, 70, 'obfuscated');
    result.counts.obfuscated++;
  }

  // === Output: dedup + sort by confidence ===
  result.all_emails = Array.from(seen.values()).sort((a, b) => b.confidence - a.confidence);

  // === Selection rule: primary_email basato su priority commerciale ===
  if (result.all_emails.length > 0) {
    const scored = result.all_emails.map((e) => {
      const local = e.email.split('@')[0] ?? '';
      // Score finale: confidence con bonus per priority commerciale (inverso del index)
      const prioBonus = Math.max(0, COMMERCIAL_LOCAL_PARTS.length - priorityOf(local));
      return { ...e, _selectionScore: e.confidence + prioBonus };
    }).sort((a, b) => b._selectionScore - a._selectionScore);
    result.primary_email = scored[0]?.email ?? null;
  }

  return result;
}
