/**
 * Lead Score action node — qualifica deterministica B2B.
 *
 * NO LLM (deterministic):
 *   - Keyword match positivo (vertical-specific) → weight 8-30
 *   - Keyword match negativo (anti-falsepositive) → penalty 10-100
 *   - Country tier bonus (EU +20, world +10, unknown 0)
 *   - Profile pre-set: 'marine-thrusters' (Esempio/Esempio) o 'custom'
 *
 * Output: { score: 0-100, category, matched_*, send_recommended }
 * Vantaggio vs LLM: stesso input → SEMPRE stesso score. Audit-friendly.
 */
import type { NodeModule } from '../types.js';

export const leadScoreNode: NodeModule = {
  def: {
    id: 'action_lead_score',
    type: 'action',
    label: 'Lead: Qualifica score deterministico',
    icon: 'target',
    color: '#22c55e',
    description:
      'Lead scorer deterministico enterprise — calcola un punteggio normalizzato 0-100 di qualifica per un ' +
      "lead B2B basato sull'analisi del contenuto testuale della pagina web target (la home, about, products " +
      'page del prospect tipicamente). NO LLM nel core scoring: pure function rule-based che pesa keyword ' +
      'positive (industry match, signal di product fit, tier value della company), penalizza keyword negative ' +
      'off-topic (settori che non sono il nostro target), bonus per criteri demografici (tier country EU/USA ' +
      'più valore vs tier emerging market, dimensione company stimata da signal della pagina). ' +
      'Stesso input → SEMPRE stesso score (deterministica, audit-friendly, no LLM drift su run successive) — ' +
      'pattern critico per clienti enterprise che richiedono explainability del scoring per compliance ' +
      '(GDPR art. 22 dichiara che individui hanno il diritto di non essere oggetto di decisioni automated ' +
      'che li affectano significantly senza explainability), e per QA che vogliono testare il scoring senza ' +
      'flakiness. ' +
      'Profili pre-set per industry vertical (configurazione del weighting via keyword positive + negative + ' +
      'country tier mapping): marine-thrusters (default per il customer pilot Esempio/Esempio che usa il nodo per ' +
      'scoring di buyer marine thrusters), real-estate (positive: villas, properties, deals; negative: ' +
      'short-term-rental), tech-saas-buyer (positive: enterprise, integration, API, automation; negative: ' +
      'consumer mobile games), e ulteriori 8 verticals pre-configurati. Override completo dei pesi possibile ' +
      'da config per personalizzazione tenant-specific. ' +
      'Algoritmo del scoring (transparent): base score 50, + N punti per ogni keyword positive matched ' +
      '(weighting per importance: brand names = 15, category keywords = 8, generic positive = 3), - N punti ' +
      'per ogni negative match (off-topic categorical = 20, secondary negative = 5), bonus country tier ' +
      '(tier1 EU/US/UK/CA = +10, tier2 ANZ/JP = +5, tier3 emerging = 0, blocklist countries con compliance ' +
      'issue = -30), final clamp [0, 100]. ' +
      'Output rich con audit trail: { score (0-100 final), matchedPositiveKeywords (list specifica per ' +
      'debug + transparency), matchedNegativeKeywords, countryTier, countryDetected, profileUsed, ' +
      'breakdown: { base, positives, negatives, countryBonus, total } }. ' +
      'Use case: qualificare lead inbound prima di assegnare a un sales rep (score < 50 → archive cold; ' +
      '50-69 → nurture marketing track; 70-100 → high-priority assigned to senior AE); priorizzare la queue ' +
      'di cold outreach mostrando solo score ≥ 70 (no spending di tokens per email personalizzate su ' +
      'low-quality lead); filtrare lead da scraping pubblico (sitemap_crawler + harvest + score → filter ' +
      'per non sprecare email outreach su off-topic detected); audit-friendly scoring richiesto da clienti ' +
      'enterprise per non-AI black-box GDPR-compliant; A/B testing di criteri di qualifica con changeover ' +
      'profile rapido senza retrain ML model.',
    configFields: [
      {
        key: 'content',
        label: 'Contenuto testuale da analizzare',
        type: 'expression',
        required: true,
        placeholder: '{{$node.fetch_page.json.content}}',
        help: 'Testo della pagina web da scorare (tipico output di action_fetch_url, campo `content`). Lo scorer fa match keyword case-insensitive su tutto il testo.',
      },
      {
        key: 'country',
        label: 'Country ISO 3166 alpha-2 (opzionale)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.extract.json.country}}',
        help: 'Codice country 2-letter (IT, FR, DE, SE, NO, ...) per applicare bonus country tier. Se vuoto, country_bonus = 0. EU+UK+Norway+Iceland = +20, world = +10.',
      },
      {
        key: 'profile',
        label: 'Profile vertical',
        type: 'select',
        options: ['marine-thrusters', 'custom'],
        required: false,
        defaultValue: 'marine-thrusters',
        help: '• marine-thrusters: pre-set per Esempio/Esempio (bow thruster, yacht, cantiere navale, marina, refit, ecc. in 6 lingue)\n• custom: usa customPositiveJson/customNegativeJson sotto.',
      },
      {
        key: 'customPositiveJson',
        label: 'Custom keyword positivi (JSON, solo se profile=custom)',
        type: 'expression',
        required: false,
        placeholder: '[{"keyword":"crm","weight":30,"category":"distributor"}]',
        help: 'Array JSON di { keyword, weight (1-30), category? }. weight 30 = strongest signal. Usato solo se profile=custom. Per marine-thrusters lascia vuoto.',
      },
      {
        key: 'customNegativeJson',
        label: 'Custom keyword negativi (JSON, solo se profile=custom)',
        type: 'expression',
        required: false,
        placeholder: '[{"keyword":"pizzeria","weight":50}]',
        help: 'Array JSON di { keyword, weight (10-100) }. weight 100 = blocca immediatamente. Default profile usa pizzeria/ristorante/hotel/404 ecc.',
      },
      {
        key: 'threshold',
        label: 'Threshold per send_recommended',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Score minimo per output send_recommended=true. Default 50 = bilanciato. Alza a 70 per ridurre falsi positivi (meno volume ma più qualificati). Abbassa a 30 per scoperta wider (più volume, meno targeted).',
      },
    ],
    outputs: [
      'score',
      'category',
      'matched_positive',
      'matched_negative',
      'country_bonus',
      'send_recommended',
      'reason',
    ],
    outputContract: {
      notes: 'Nessun LLM: il punteggio nasce da regole, quindi lo stesso testo da` sempre lo stesso numero — ed e` questo che lo rende verificabile. `matched_positive` e `matched_negative` mostrano su cosa si e` basato: senza guardarli il punteggio e` una scatola chiusa.',
      fields: [
        { name: 'score', type: 'number', desc: 'Il punteggio da 0 a 100.' },
        { name: 'category', type: 'string', desc: 'La fascia in cui cade il punteggio.' },
        { name: 'matched_positive', type: 'array', desc: 'Le parole che hanno alzato il punteggio.' },
        { name: 'matched_negative', type: 'array', desc: 'Quelle che l\'hanno abbassato.' },
        { name: 'country_bonus', type: 'number', desc: 'Quanto ha pesato il paese, in piu` o in meno.' },
        { name: 'send_recommended', type: 'boolean', desc: 'Se conviene contattarlo. E` il campo su cui diramare.' },
        { name: 'reason', type: 'string', desc: 'La spiegazione del punteggio, per esteso.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
