/**
 * Lead Score — qualifica deterministica B2B per workflow cold outreach.
 *
 * PERCHE' DETERMINISTICO E NON LLM:
 * Un LLM relevance_score può drift fra modelli (Claude vs GPT vs Liara) +
 * inconsistente nel tempo (stesso input → score diverso). Per un workflow
 * production che decide CHI ricevere email reali, serve OUTPUT IDENTICO
 * AD OGNI ESECUZIONE con stesso input — solo deterministico lo garantisce.
 *
 * SIGNAL MULTI-DIMENSION (configurabili):
 *
 * 1. **Keyword positivo** (per industry vertical):
 *    Match esatti weighted nel content scraped del sito target.
 *    Default profile "marine-thrusters": bow thruster, yacht, marina,
 *    cantiere navale, shipyard, refit, hydraulic, propulsion.
 *
 * 2. **Keyword negativo** (anti-falsepositive):
 *    Match che squalifica: pizzeria, ristorante, hotel, blog personale,
 *    "page not found", servizi non-related.
 *
 * 3. **Country tier** (per outreach EU-first):
 *    EU + Scandinavia + UK = priority alta
 *    World rest = priority media
 *    Unknown = priority bassa
 *
 * 4. **Page structure signals** (positivo):
 *    - Presenza sezione Products/Prodotti
 *    - Presenza sezione Contact/Contatti
 *    - Form preventivo/quote
 *    - Cataloghi PDF/spec sheets
 *
 * 5. **Anti-spam signals** (negativo):
 *    - "404", "Page not found", "Site under construction"
 *    - "Buy now", "Click here" (e-commerce noise)
 *    - "wordpress.com", "wix.com", "squarespace.com" subdomain
 *      (probabile sito hobbistico non aziendale)
 *
 * OUTPUT:
 *   - score: 0-100 (lineare)
 *   - category: 'shipyard' | 'distributor' | 'marina' | 'service' | 'unknown'
 *   - matched_positive: [string] keyword matched
 *   - matched_negative: [string] keyword anti-matched
 *   - reason: human-readable why
 *   - send_recommended: bool (score >= threshold)
 */

export interface LeadScoreConfig {
  /** Soglia minima per send_recommended (default 50). */
  threshold?: number;
  /** Profile pre-set: 'marine-thrusters' (verticale nautica) | 'custom'. */
  profile?: 'marine-thrusters' | 'custom';
  /** Custom keywords se profile=custom. */
  customPositive?: { keyword: string; weight: number; category?: string }[];
  customNegative?: { keyword: string; weight: number }[];
  /** Country list considerati "high priority" (default EU+UK+Norway+Iceland). */
  highPriorityCountries?: string[];
}

export interface LeadScoreResult {
  /** Score finale 0-100. >= threshold → send_recommended=true. */
  score: number;
  /** Categoria detected dal pattern keyword. */
  category: 'shipyard' | 'distributor' | 'marina' | 'service' | 'unknown';
  /** Lista keyword positivi matched, weighted */
  matched_positive: { keyword: string; weight: number; count: number }[];
  /** Lista keyword negativi matched (squalificano) */
  matched_negative: { keyword: string; weight: number; count: number }[];
  /** Country tier bonus applicato */
  country_bonus: number;
  /** True se score >= threshold (default 50) */
  send_recommended: boolean;
  /** Human-readable reason for UI tooltip */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────
// PROFILE: marine-thrusters (verticale nautica)
// Keywords curate per settore B2B nautico costruzioni navali.
// Weight 1-30 per granularità. Total positivo max ~80, country bonus +20.
// ─────────────────────────────────────────────────────────────────────────

const PROFILE_MARINE_POSITIVE: {
  keyword: string;
  weight: number;
  category: LeadScoreResult['category'];
}[] = [
  // CATEGORIA: shipyard / cantieri
  { keyword: 'bow thruster', weight: 30, category: 'shipyard' },
  { keyword: 'stern thruster', weight: 25, category: 'shipyard' },
  { keyword: 'elica di prua', weight: 30, category: 'shipyard' },
  { keyword: 'elica di poppa', weight: 25, category: 'shipyard' },
  { keyword: 'propulseur', weight: 25, category: 'shipyard' },
  { keyword: 'bugstrahlruder', weight: 30, category: 'shipyard' },
  { keyword: 'heckstrahlruder', weight: 25, category: 'shipyard' },
  { keyword: 'cantiere navale', weight: 25, category: 'shipyard' },
  { keyword: 'cantiere nautico', weight: 25, category: 'shipyard' },
  { keyword: 'shipyard', weight: 25, category: 'shipyard' },
  { keyword: 'chantier naval', weight: 25, category: 'shipyard' },
  { keyword: 'astillero', weight: 25, category: 'shipyard' },
  { keyword: 'werft', weight: 25, category: 'shipyard' },
  { keyword: 'varv', weight: 20, category: 'shipyard' }, // svedese
  { keyword: 'verft', weight: 20, category: 'shipyard' }, // norvegese
  { keyword: 'værft', weight: 20, category: 'shipyard' }, // danese
  { keyword: 'telakka', weight: 20, category: 'shipyard' }, // finlandese
  { keyword: 'skipasmíðastöð', weight: 20, category: 'shipyard' }, // islandese
  // CATEGORIA: distributor
  { keyword: 'marine hydraulic', weight: 25, category: 'distributor' },
  { keyword: 'distributor', weight: 15, category: 'distributor' },
  { keyword: 'distributore nautico', weight: 20, category: 'distributor' },
  { keyword: 'dealer', weight: 12, category: 'distributor' },
  { keyword: 'rivenditore', weight: 12, category: 'distributor' },
  { keyword: 'agent', weight: 10, category: 'distributor' },
  // CATEGORIA: marina / porto turistico
  { keyword: 'marina', weight: 15, category: 'marina' },
  { keyword: 'porto turistico', weight: 20, category: 'marina' },
  { keyword: 'yacht club', weight: 15, category: 'marina' },
  { keyword: 'yacht harbour', weight: 18, category: 'marina' },
  { keyword: 'yacht service', weight: 20, category: 'service' },
  // CATEGORIA: service / refit
  { keyword: 'refit', weight: 20, category: 'service' },
  { keyword: 'ship repair', weight: 20, category: 'service' },
  { keyword: 'rifit nautico', weight: 20, category: 'service' },
  { keyword: 'manutenzione nautica', weight: 18, category: 'service' },
  { keyword: 'thruster repair', weight: 25, category: 'service' },
  // GENERIC marine (basso peso, no category dominante)
  { keyword: 'yacht', weight: 8, category: 'shipyard' },
  { keyword: 'mega-yacht', weight: 15, category: 'shipyard' },
  { keyword: 'megayacht', weight: 15, category: 'shipyard' },
  { keyword: 'superyacht', weight: 18, category: 'shipyard' },
  { keyword: 'yachting', weight: 10, category: 'shipyard' },
  { keyword: 'boat builder', weight: 18, category: 'shipyard' },
  { keyword: 'costruttore nautico', weight: 18, category: 'shipyard' },
  { keyword: 'imbarcazione', weight: 8, category: 'shipyard' },
  { keyword: 'nautical', weight: 6, category: 'shipyard' },
  { keyword: 'nautico', weight: 6, category: 'shipyard' },
  { keyword: 'maritime', weight: 6, category: 'shipyard' },
  { keyword: 'hydraulic', weight: 8, category: 'distributor' },
  { keyword: 'idraulico', weight: 8, category: 'distributor' },
  { keyword: 'propulsion', weight: 12, category: 'shipyard' },
  { keyword: 'propulsione', weight: 12, category: 'shipyard' },
];

const PROFILE_MARINE_NEGATIVE: { keyword: string; weight: number }[] = [
  // Categorie completamente OFF-TOPIC
  { keyword: 'pizzeria', weight: 50 },
  { keyword: 'ristorante', weight: 40 },
  { keyword: 'restaurant', weight: 40 },
  { keyword: 'hotel', weight: 30 },
  { keyword: 'albergo', weight: 30 },
  { keyword: 'b&b', weight: 30 },
  { keyword: 'bed and breakfast', weight: 30 },
  { keyword: 'agriturismo', weight: 30 },
  { keyword: 'real estate', weight: 30 },
  { keyword: 'immobiliare', weight: 30 },
  { keyword: 'parrucchier', weight: 40 }, // parrucchiere/parrucchiera
  { keyword: 'beauty salon', weight: 40 },
  { keyword: 'centro estetico', weight: 40 },
  { keyword: 'pet shop', weight: 35 },
  { keyword: 'farmacia', weight: 30 },
  { keyword: 'pharmacy', weight: 30 },
  { keyword: 'mortgage', weight: 30 },
  { keyword: 'lawyer', weight: 25 },
  { keyword: 'avvocato', weight: 25 },
  // Errori tecnici → no business
  { keyword: '404 not found', weight: 100 },
  { keyword: 'site under construction', weight: 80 },
  { keyword: 'sito in costruzione', weight: 80 },
  { keyword: 'coming soon', weight: 60 },
  // E-commerce noise (per generic e-shop NON è target)
  { keyword: 'add to cart', weight: 10 },
  { keyword: 'buy now', weight: 8 },
  { keyword: 'aggiungi al carrello', weight: 10 },
];

const DEFAULT_HIGH_PRIORITY_COUNTRIES = [
  'IT',
  'FR',
  'DE',
  'ES',
  'NL',
  'BE',
  'PT',
  'GR',
  'HR',
  'SI',
  'AT',
  'CH',
  'SE',
  'NO',
  'DK',
  'FI',
  'IS',
  'UK',
  'GB',
  'IE',
  'MT',
  'CY',
];

// ─────────────────────────────────────────────────────────────────────────
// Main scorer
// ─────────────────────────────────────────────────────────────────────────

export function scoreLeadFromContent(
  content: string,
  country: string | undefined,
  config: LeadScoreConfig = {},
): LeadScoreResult {
  const profile = config.profile ?? 'marine-thrusters';
  const positiveKw =
    profile === 'marine-thrusters'
      ? PROFILE_MARINE_POSITIVE
      : (config.customPositive ?? []).map((p) => ({
          ...p,
          category: (p.category as LeadScoreResult['category']) ?? 'unknown',
        }));
  const negativeKw =
    profile === 'marine-thrusters' ? PROFILE_MARINE_NEGATIVE : (config.customNegative ?? []);
  const highPriority = config.highPriorityCountries ?? DEFAULT_HIGH_PRIORITY_COUNTRIES;
  const threshold = config.threshold ?? 50;

  const lower = content.toLowerCase();

  // === Positivo matching con count ===
  const matched_positive: LeadScoreResult['matched_positive'] = [];
  const categoryHits: Record<string, number> = {};
  let positiveScore = 0;
  for (const k of positiveKw) {
    const re = new RegExp(
      `\\b${k.keyword.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`,
      'g',
    );
    const matches = lower.match(re);
    if (matches && matches.length > 0) {
      const count = matches.length;
      matched_positive.push({ keyword: k.keyword, weight: k.weight, count });
      // Score: weight base + bonus log(count) per multi-hit (diminishing returns)
      positiveScore += k.weight + Math.min(10, Math.log2(count) * 3);
      const cat = (k as { category?: string }).category ?? 'unknown';
      categoryHits[cat] = (categoryHits[cat] ?? 0) + k.weight * count;
    }
  }

  // === Negativo matching ===
  const matched_negative: LeadScoreResult['matched_negative'] = [];
  let negativeScore = 0;
  for (const k of negativeKw) {
    const re = new RegExp(
      `\\b${k.keyword.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`,
      'g',
    );
    const matches = lower.match(re);
    if (matches && matches.length > 0) {
      const count = matches.length;
      matched_negative.push({ keyword: k.keyword, weight: k.weight, count });
      negativeScore += k.weight * Math.min(count, 3); // cap 3× per evitare false alarm su pagina con 50× "pizzeria"
    }
  }

  // === Country bonus ===
  let country_bonus = 0;
  const cc = (country ?? '').toUpperCase();
  if (highPriority.includes(cc)) country_bonus = 20;
  else if (cc && cc !== 'XX' && cc.length === 2) country_bonus = 10;

  // === Final score (clamp 0-100) ===
  const rawScore = positiveScore - negativeScore + country_bonus;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // === Category dominante ===
  let category: LeadScoreResult['category'] = 'unknown';
  if (Object.keys(categoryHits).length > 0) {
    const sorted = Object.entries(categoryHits).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    if (
      top &&
      (top[0] === 'shipyard' ||
        top[0] === 'distributor' ||
        top[0] === 'marina' ||
        top[0] === 'service')
    ) {
      category = top[0];
    }
  }

  // === Reason ===
  let reason = '';
  if (negativeScore > 30) {
    reason = `Squalificato: keyword off-topic rilevati (${matched_negative
      .slice(0, 2)
      .map((m) => m.keyword)
      .join(', ')})`;
  } else if (positiveScore === 0) {
    reason =
      'Nessuna keyword nautica rilevata nel contenuto — probabilmente NON è un target valido';
  } else {
    reason =
      `${matched_positive.length} keyword positivi (top: ${matched_positive
        .slice(0, 3)
        .map((m) => m.keyword)
        .join(', ')})` + (country_bonus > 0 ? ` + country tier ${cc} (+${country_bonus})` : '');
  }

  return {
    score,
    category,
    matched_positive,
    matched_negative,
    country_bonus,
    send_recommended: score >= threshold,
    reason,
  };
}
