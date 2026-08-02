/**
 * Email Personalize action node — LLM genera 1-2 frasi UNIQUE per cantiere.
 *
 * Pattern enterprise B2B: cold outreach con personalization = 5-10× reply rate.
 *
 * LLM-driven (BYO provider via llmResolver), MA con guard-rail rigorosi:
 *   - JSON Schema strict output
 *   - Anti-hallucination: evidence_quote DEVE essere substring del content
 *   - Profanity + spam-trigger blacklist
 *   - Token budget cap (max 300 = ~200 parole)
 *   - Cache LRU 1h per (content_hash, lang, company) — re-run idempotente
 *   - Fallback gracioso: se LLM fail → success=false, workflow continua
 *     con template generic (no exception bubble nel pipeline)
 */
import type { NodeModule } from '../types.js';

export const emailPersonalizeNode: NodeModule = {
  def: {
    id: 'action_email_personalize',
    type: 'action',
    label: 'Email: Personalizza con AI (1-2 frasi)',
    icon: 'sparkles',
    color: '#a855f7',
    description:
      'Generatore enterprise di personalizzazioni email AI-powered per cold outreach commerciale — la primitiva ' +
      'che trasforma sequence di email mass-mailing fredde "Ciao, abbiamo un prodotto per te" in messaggi ' +
      '1-to-1 che fanno apparire la comunicazione manuale e cura del prospect specifico (reply rate aumentano ' +
      '3-5x rispetto a template generico in studi A/B di sales outbound enterprise). Genera 1-2 frasi ' +
      "personalizzate da iniettare nell'opening del messaggio cold che CITINO una caratteristica REALE e " +
      "specifica dell'azienda destinataria — estratta dal content del loro sito web reale che il workflow " +
      'ha scaricato upstream (action_web_fetch_advanced sulla home/about/products del prospect). ' +
      "Anti-hallucination check obbligatorio enterprise: l'evidence_quote (la frase originale dal sito che " +
      'ha ispirato la personalizzazione) DEVE essere substring esatta del content originale fornito al nodo ' +
      '— se il LLM provasse a inventare ("la vostra certificazione ISO 9001 ottenuta nel 2024" quando NON ' +
      'è nel sito), il check fallisce e il nodo ritorna fallback graceful (saluto generico safe-default) ' +
      'invece di mentire al prospect. Pattern di tutela reputational vs LLM hallucination noto, critico per ' +
      'B2B sales dove un dato sbagliato distrugge la deal pipeline. ' +
      'Multi-lingua native (14 supportate): italiano, inglese, spagnolo, francese, tedesco, portoghese, ' +
      'olandese, danese, svedese, norvegese, finlandese, polacco, ceco, rumeno — auto-detect dalla lingua del ' +
      'content website oppure override esplicito per outreach internazionale targeted (es. cold outreach a ' +
      'distributori italiani che vendono prodotti tedeschi, language=de per matching il vendor expectation). ' +
      'Cache 1h per content_hash per evitare LLM calls ridondanti su stesso target: se il workflow itera su ' +
      '100 lead della stessa azienda (es. team Sales Outreach che colpiscono CTO+CFO+CEO stesso prospect), ' +
      'il LLM call avviene UNA volta e tutti i 3 messaggi riusano la same personalization base — risparmio ' +
      '90%+ sui token Liara/BYOK. ' +
      'Fallback gracioso multi-livello: LLM fail (timeout, rate limit, content moderation) → opener generico ' +
      'safe-default "Salve {{firstName}}, le scrivo perché credo {{company}} potrebbe..."; content troppo ' +
      'corto (< 100 char) → skip personalization e usa opener default; content > 4000 char auto-truncate ' +
      'mantenendo i primi 2000 + ultimi 2000 (capture intro + footer aziendale che contiene tipicamente la ' +
      'signal value). ' +
      'Output: { personalizedOpener (1-2 frasi pronte da iniettare nel template email), evidenceQuote (la ' +
      'frase originale del sito che ha ispirato — utile per debug + audit), language, contentHash, ' +
      'cacheUsed, fallbackReason? }. ' +
      'Use case: cold outreach B2B con apertura personalizzata da fatto vero del sito target (3-5x reply rate ' +
      'vs template generic); follow-up post-form con riferimento a sezione del sito visitata che il lead ha ' +
      'mostrato interesse (tracked dal form analytics); reply-handling che cita prodotto specifico chiesto ' +
      'dal lead in reply precedente; multi-lingua automatic per outreach internazionale targeted di settori ' +
      'specifici (es. outreach a buyer tedeschi del settore food italiano export); ABM (Account Based ' +
      'Marketing) per high-value enterprise account con messaggi totally tailored.',
    configFields: [
      {
        key: 'content',
        label: 'Contenuto testuale del sito target',
        type: 'expression',
        required: true,
        placeholder: '{{$node.fetch_page.json.content}}',
        help: 'Testo della pagina del cantiere/azienda destinataria, tipico output di action_fetch_url (campo content). LLM analizza per estrarre signal personalization (prodotti, certificazioni, anni di attività). Min 100 char, max 4000 char (auto-truncate).',
      },
      {
        key: 'company_name',
        label: 'Nome azienda destinataria',
        type: 'expression',
        required: true,
        placeholder: '{{$node.extract_contact.json.company_name}}',
        help: 'Nome azienda (es. "Cantieri Sangermani"). Usato nel snippet per evitare frasi generiche.',
      },
      {
        key: 'language',
        label: 'Lingua di output',
        type: 'expression',
        required: true,
        placeholder: '{{$node.detect_lang.json.language}}',
        help: 'Codice lingua 2-letter (it/en/de/fr/es/pt/nl/el/hr/sv/no/da/fi/is). Il snippet viene generato in questa lingua, coerente col template email.',
      },
      {
        key: 'tone',
        label: 'Tono comunicazione',
        type: 'select',
        options: ['formal', 'conversational'],
        required: false,
        defaultValue: 'formal',
        help: '• formal (default per B2B nautico): voi-form, tono professionale\n• conversational: tu-form, più diretto. Usa solo per startup/agencies, MAI per cantieri tradizionali.',
      },
      {
        key: 'sender_product_context',
        label: 'Contesto prodotto sender (per guidare AI)',
        type: 'expression',
        required: false,
        defaultValue:
          'producono motori idraulici e eliche di manovra per la nautica (bow thrusters, stern thrusters, unità di propulsione)',
        help: 'Descrizione 1 riga di cosa vendete. Aiuta il LLM a generare snippet che COLLEGA il loro business al vostro prodotto. Default: propulsori nautici. Personalizza per altre verticali.',
      },
    ],
    outputs: [
      'snippet',
      'evidence_quote',
      'confidence',
      'success',
      'reason',
      'llm_provider',
      'llm_model',
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
