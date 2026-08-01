/**
 * Domain-specialised email triage for studi commercialisti italiani.
 *
 * Difference vs the generic `lib/email/triage.ts`
 * ───────────────────────────────────────────────
 * The generic triage returns language / urgency / isPec / isNewsletter — useful
 * but UNcategorical. A real studio needs the label TAXONOMY:
 *
 *   • fiscale          — dichiarazioni, regime fiscale, ravvedimento
 *   • iva              — IVA, intra, esterometro, pl. INTRA
 *   • f24              — pagamenti, ravvedimento, codice tributo
 *   • forfettario      — regime forfettario, flat-tax
 *   • sollecito        — pagamento mancato, scadenza superata
 *   • pec_legal        — PEC certificata art.6 DPR 68/05, ricevute conservazione
 *   • payment          — bonifico, fattura pagata, ricevuta accredito
 *   • bilancio         — bilancio, nota integrativa, deposito CCIAA
 *   • altro            — fallback
 *
 * Each label has a `keywords` array used for case-insensitive substring +
 * token matching. The matcher returns confidence ≈ (matched keywords) /
 * (total keywords scanned), clamped to [0.05, 0.95].
 *
 * Each label maps to:
 *   • suggestedOperator — the human handler the studio has assigned
 *   • suggestedReplyTemplate — short reply skeleton (IT, polite)
 *   • urgencyTier ('high' | 'normal' | 'low')
 *
 * The rules engine is PURE (no LLM, no network, deterministic). When the
 * studio wants AI-enhanced classification, chain a `agent_classifier` AFTER
 * this node with the labels enriched with confidence — the LLM gets fewer
 * tokens to chew and starts from a sane prior.
 *
 * @module lib/email/triage-commercialista
 */

export type CommercialistaLabel =
  | 'fiscale' | 'iva' | 'f24' | 'forfettario'
  | 'sollecito' | 'pec_legal' | 'payment' | 'bilancio' | 'altro';

export interface RuleSet {
  label: CommercialistaLabel;
  keywords: readonly string[];
  /** When true, a single match is enough — used for narrow critical labels. */
  highConfidenceOnSingleMatch?: boolean;
}

export interface TriageInput {
  subject?: string | null;
  body?: string | null;
  from?: string | null;
}

export interface TriageReply {
  label: CommercialistaLabel;
  confidence: number;
  matchedKeywords: readonly string[];
  suggestedOperator: string;
  suggestedReplyTemplate: string;
  urgencyTier: 'high' | 'normal' | 'low';
}

/** Default rules — tarate sull'agenda di uno studio commercialista IT 2026. */
export const DEFAULT_RULES: readonly RuleSet[] = Object.freeze([
  {
    label: 'sollecito',
    keywords: ['sollecito', 'mancato pagamento', 'scaduta', 'scadenza superata', 'in mora', 'recupero crediti'],
    highConfidenceOnSingleMatch: true,
  },
  {
    label: 'pec_legal',
    keywords: ['ricevuta di accettazione', 'ricevuta di consegna', 'avviso non accettazione', 'busta di trasporto', 'avviso di mancata consegna', 'pec'],
  },
  {
    label: 'f24',
    keywords: ['f24', 'codice tributo', 'modello f24', 'ravvedimento operoso', 'tributo'],
  },
  {
    label: 'iva',
    keywords: ['iva', 'intra', 'esterometro', 'lipe', 'liquidazione periodica iva', 'partita iva', 'reverse charge'],
  },
  {
    label: 'fiscale',
    keywords: ['730', '770', 'unico', 'dichiarazione dei redditi', 'redditi', 'agenzia delle entrate', 'cu', 'certificazione unica'],
  },
  {
    label: 'forfettario',
    keywords: ['regime forfettario', 'forfettario', 'flat tax', 'flat-tax', 'coefficiente di redditivita`'],
  },
  {
    label: 'bilancio',
    keywords: ['bilancio', 'nota integrativa', 'deposito bilancio', 'cciaa', 'verbale assemblea', 'deposito atti'],
  },
  {
    label: 'payment',
    keywords: ['bonifico effettuato', 'pagamento ricevuto', 'fattura pagata', 'accredito', 'pagamento avvenuto'],
  },
]);

/** Default operator mapping — overridable from config. */
export const DEFAULT_OPERATORS: Record<CommercialistaLabel, string> = Object.freeze({
  fiscale: 'fiscale@studio',
  iva: 'iva@studio',
  f24: 'pagamenti@studio',
  forfettario: 'fiscale@studio',
  sollecito: 'titolare@studio',
  pec_legal: 'archivio@studio',
  payment: 'amministrazione@studio',
  bilancio: 'societario@studio',
  altro: 'segreteria@studio',
});

/** Reply skeletons (IT polite). */
export const DEFAULT_REPLY_TEMPLATES: Record<CommercialistaLabel, string> = Object.freeze({
  fiscale: 'Buongiorno, abbiamo ricevuto la sua richiesta in ambito fiscale. La presa in carico avverra` a breve dall\'operatore competente. Cordiali saluti.',
  iva: 'Buongiorno, abbiamo ricevuto la sua richiesta IVA. La presa in carico avverra` a breve. Cordiali saluti.',
  f24: 'Buongiorno, abbiamo ricevuto la richiesta relativa al pagamento F24. Riceverà conferma a breve. Cordiali saluti.',
  forfettario: 'Buongiorno, abbiamo ricevuto la richiesta in tema di regime forfettario. La presa in carico avverra` a breve. Cordiali saluti.',
  sollecito: 'Buongiorno, abbiamo ricevuto il suo sollecito. Verifichiamo immediatamente la posizione e la ricontatteremo entro 24h. Cordiali saluti.',
  pec_legal: 'PEC ricevuta. Conservazione a norma effettuata. Cordiali saluti.',
  payment: 'Buongiorno, confermiamo la ricezione del pagamento. Sara` registrato nei nostri sistemi entro 24h. Cordiali saluti.',
  bilancio: 'Buongiorno, abbiamo ricevuto la sua richiesta in tema di bilancio. La presa in carico avverra` a breve. Cordiali saluti.',
  altro: 'Buongiorno, abbiamo ricevuto la sua email. Verra` indirizzata al referente competente. Cordiali saluti.',
});

/** Urgency tier mapping — adjustable from config. */
export const DEFAULT_URGENCY: Record<CommercialistaLabel, 'high' | 'normal' | 'low'> = Object.freeze({
  sollecito: 'high',
  pec_legal: 'high',
  f24: 'high',
  iva: 'normal',
  fiscale: 'normal',
  forfettario: 'normal',
  bilancio: 'normal',
  payment: 'low',
  altro: 'low',
});

export interface ClassifyOptions {
  rules?: readonly RuleSet[];
  operators?: Partial<Record<CommercialistaLabel, string>>;
  replyTemplates?: Partial<Record<CommercialistaLabel, string>>;
  urgency?: Partial<Record<CommercialistaLabel, 'high' | 'normal' | 'low'>>;
}

/**
 * Top-level classifier. Concatenates subject + body, scans against each
 * rule's keyword list, picks the rule with the highest match count
 * (ties broken by rule order — earlier rules win).
 */
export function classifyCommercialistaEmail(
  input: TriageInput,
  opts: ClassifyOptions = {},
): TriageReply {
  const rules = opts.rules ?? DEFAULT_RULES;
  const ops = { ...DEFAULT_OPERATORS, ...(opts.operators ?? {}) };
  const tmpls = { ...DEFAULT_REPLY_TEMPLATES, ...(opts.replyTemplates ?? {}) };
  const urg = { ...DEFAULT_URGENCY, ...(opts.urgency ?? {}) };

  const haystack = `${input.subject ?? ''}\n${input.body ?? ''}`.toLowerCase();
  if (haystack.trim().length === 0) {
    return makeFallback('altro', [], ops, tmpls, urg);
  }

  let bestRule: RuleSet | null = null;
  let bestMatches: string[] = [];
  let bestCount = 0;

  for (const rule of rules) {
    const matches: string[] = [];
    for (const kw of rule.keywords) {
      if (haystack.includes(kw.toLowerCase())) matches.push(kw);
    }
    if (matches.length > bestCount) {
      bestCount = matches.length;
      bestRule = rule;
      bestMatches = matches;
      if (rule.highConfidenceOnSingleMatch && matches.length > 0) break;
    }
  }

  if (bestRule === null || bestCount === 0) {
    return makeFallback('altro', [], ops, tmpls, urg);
  }

  const denom = bestRule.highConfidenceOnSingleMatch ? 1 : bestRule.keywords.length;
  const ratio = bestCount / denom;
  const confidence = Math.min(0.95, Math.max(0.05, ratio));

  return {
    label: bestRule.label,
    confidence,
    matchedKeywords: Object.freeze(bestMatches),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    suggestedOperator: ops[bestRule.label] ?? DEFAULT_OPERATORS[bestRule.label],
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    suggestedReplyTemplate: tmpls[bestRule.label] ?? DEFAULT_REPLY_TEMPLATES[bestRule.label],
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
    urgencyTier: urg[bestRule.label] ?? DEFAULT_URGENCY[bestRule.label],
  };
}

function makeFallback(
  label: CommercialistaLabel,
  matches: string[],
  ops: Record<CommercialistaLabel, string>,
  tmpls: Record<CommercialistaLabel, string>,
  urg: Record<CommercialistaLabel, 'high' | 'normal' | 'low'>,
): TriageReply {
  return {
    label,
    confidence: 0.1,
    matchedKeywords: Object.freeze(matches),
    suggestedOperator: ops[label],
    suggestedReplyTemplate: tmpls[label],
    urgencyTier: urg[label],
  };
}
