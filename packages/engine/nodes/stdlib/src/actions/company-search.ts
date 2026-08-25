/**
 * Company Search — discovery aziende reali per cold outreach B2B.
 *
 * Pipeline 2026 (Apollo/Clay/Phantombuster pattern):
 *   1. LLM query expansion (Liara/Anthropic/OpenAI/Gemini — BYO)
 *   2. Multi-source: Exa→Tavily→Brave→Serper→DDG (cascade)
 *   3. Anti-directory filter: blocklist 60+ aggregator/blog/social/marketplace
 *   4. TLD preference + boost domini "puliti"
 *   5. HEAD validation: solo siti vivi
 *   6. De-dup per registrable domain
 */
import type { NodeModule } from '../types.js';

export const companySearchNode: NodeModule = {
  def: {
    id: 'action_company_search',
    type: 'action',
    label: 'Aziende: Ricerca avanzata (LLM + multi-source)',
    icon: 'building-2',
    color: '#8b5cf6',
    description:
      'Discovery enterprise di URL di AZIENDE REALI per cold outreach B2B — la primitiva per costruire seed ' +
      'list di prospect target da zero senza dover comprare database statici come ZoomInfo/Apollo/SalesNavigator. ' +
      'Risolve il problema #1 del cold outreach moderno: trovare le aziende right-fit per il proprio prodotto ' +
      'nel territorio target, evitando il rumore di directory aggregatori (yellowpages, paginegialle, ' +
      'similarsites), blog content marketing che parlano del settore ma non ne sono parte attiva, link farm ' +
      'SEO che inquinano i risultati Google. ' +
      'Pipeline multi-stage avanzata: (1) LLM query expansion — l\'utente passa una query high-level "cantieri ' +
      'navali Croazia 20-50m" e il LLM espande in 5-10 query specialized che catturano sinonimi industry ' +
      '("shipyard Hrvatska", "yacht builders Croatia", "boat manufacturers Dalmatian coast", "production ' +
      'lines vessel 20m"), pattern per coverage che pura keyword search miss; (2) multi-source search ' +
      'parallel su 4 search engine indipendenti (Exa.ai per semantic neural search optimized per discovery, ' +
      'Tavily AI per recente fresh content, Brave Search per anti-Google bias, DuckDuckGo per privacy + ' +
      "independent results) — l'unione dei result set dei 4 sources è più completa di qualsiasi singolo; " +
      '(3) anti-directory blocklist — filter post-processing che rimuove i top 200 directory/aggregator ' +
      'noti (yelp.com, yelp.it, paginegialle.it, europages.com, kompass.com, ecc.) che otherwise inquinano ' +
      'i result; (4) HEAD validation — quick HEAD request per ogni URL trovato per verificare che il sito ' +
      'risponde 200 (no 404/410 dead links, no 5xx down servers); (5) de-dup intelligente che matcha URL ' +
      'paths simili e domini canonical (www.acme.com vs acme.com). ' +
      'Output: array di { url, domain, title (dalla SERP), description (snippet), boost_factors (lista dei ' +
      'signal positivi che hanno ranked questo result), source (quale dei 4 search engines lo ha trovato), ' +
      'confidence } — ranking finale weighted per source di trust + match strength + freshness. ' +
      'LLM-agnostic per query expansion: lo step LLM usa il provider configurato del tenant (Liara Qwen3 ' +
      'self-hosted default zero-cost, oppure Anthropic Claude/OpenAI GPT/Gemini via BYOK). ' +
      'Use case: lead-gen B2B su nicchia verticale specifica (es. "produttori di pannelli fotovoltaici Sicilia ' +
      '20MW+", "studi commercialisti specializzati in cripto-asset Milano"); discovery competitor nel mercato ' +
      'target prima di un lancio prodotto (mapping landscape competitivo); seed list per campagne ABM ' +
      '(account-based marketing) high-touch con messaggi ultra-customizzati per ogni account; prima fase di ' +
      'una pipeline downstream che poi arricchisce con contact-discovery (chi sono i decision-maker?) + ' +
      'email-validate-mx (sono email deliverable?) + personalization AI; analisi competitiva con scoring ' +
      'comparativo (chi sono i top 50 player del nostro mercato e dove sono attivi).',
    configFields: [
      // ─── Input principale ──────────────────────────────────────────
      {
        key: 'seedPrompt',
        label: 'Cosa cercare (prompt seed)',
        type: 'text',
        required: true,
        placeholder: 'yacht builder Italia, cantieri navali produttori',
        help:
          "Descrizione di cosa cercare. L'LLM lo espanderà in N query DDG variate. " +
          'PIÙ SPECIFICO = MIGLIORI RISULTATI:\n' +
          '✓ "cantieri navali yacht Italia produttori barche da diporto"\n' +
          '✗ "barche" (troppo generico)\n' +
          'Suggerimenti: includi vertical + paese + ICP (es. "studi notarili Milano patrimonio", "officine meccaniche Brescia CNC").',
      },

      // ─── Scope risultati ───────────────────────────────────────────
      {
        key: 'maxResults',
        label: 'Numero massimo aziende',
        type: 'number',
        required: false,
        defaultValue: '20',
        help:
          'Hard cap di company URL ritornati DOPO tutti i filtri.\n' +
          '• 5 = test rapido (~5s)\n' +
          '• 20 = default bilanciato (~15s, 1 campagna ridotta)\n' +
          '• 50 = ampio (~30s, 1 campagna completa)\n' +
          '• 100 = max raccomandato (~60s, costo Tavily/Exa più alto)',
      },
      {
        key: 'queryExpansionCount',
        label: 'Query LLM-generate',
        type: 'number',
        required: false,
        defaultValue: '5',
        help:
          "Quante query variate l'LLM deve generare DA PARTIRE dal seed.\n" +
          '• 0 = disabilita LLM (usa solo seed). Risparmia 1 token call ma minor copertura.\n' +
          '• 3 = stretto, focus stretto sul vertical\n' +
          '• 5 = default bilanciato (~50 risultati raw)\n' +
          '• 10 = ampio, esplora più angoli (esempi: cantieri + officine + costruttori)',
      },
      {
        key: 'resultsPerQuery',
        label: 'Risultati per query',
        type: 'number',
        required: false,
        defaultValue: '10',
        help:
          'Quanti risultati prendere da ogni search engine per ogni query. ' +
          '• 5 = veloce, top-tier\n' +
          '• 10 = default (coverage decente)\n' +
          '• 20 = max (più chance di trovare aziende non-top-ranked)\n' +
          'Costo: lineare con questo valore × query_count × provider_costs.',
      },

      // ─── Localizzazione ────────────────────────────────────────────
      {
        key: 'country',
        label: 'Codice paese ISO (TLD preference)',
        type: 'text',
        required: false,
        placeholder: 'it, de, fr, es, uk, ...',
        help:
          'ISO country code. Aziende con dominio .{country} ricevono boost di ranking. ' +
          'L\'LLM include automaticamente "site:.{country}" in alcune query.\n' +
          'Esempi: "it" per Italia, "de" per Germania, "fr" per Francia.\n' +
          'Lascia vuoto per discovery global.',
      },

      // ─── Filtri ────────────────────────────────────────────────────
      {
        key: 'extraBlocklist',
        label: 'Domini da escludere (CSV)',
        type: 'text',
        required: false,
        placeholder: 'concorrente1.com, partner.it, marketplace-x.com',
        help:
          'Domini da escludere AGGIUNTIVI rispetto alla blocklist default (60+ directory già esclusi: yachtall, yachtworld, inautia, linkedin, facebook, amazon, ebay, ecc.). ' +
          'CSV. Use case: escludere concorrenti diretti, partner già contattati, marketplace specifici.',
      },
      {
        key: 'requireKeyword',
        label: 'Keyword OBBLIGATORIA nella homepage (avanzato)',
        type: 'text',
        required: false,
        placeholder: 'yacht, marine, naval',
        help:
          'Se settato, dopo il search il nodo fetch-a la homepage di ogni candidate e verifica la presenza del keyword (case-insensitive) in <title>/<meta>/<h1>. ' +
          "Se assente, l'URL viene scartato.\n" +
          'AGGRESSIVO: scarta ~30-50% candidate, ma garantisce focus stretto sul vertical. ' +
          'Use case: vuoi SOLO siti che parlano del tuo target (no false positivi da search engine).',
      },

      // ─── LLM provider ───────────────────────────────────────────────
      {
        key: 'skipLLMExpansion',
        label: 'Salta LLM (usa solo seed query)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          "Se ON, NON chiama LLM per espandere il seed. Usa SOLO la query così com'è.\n" +
          'Vantaggi: gratuito (0 token), più veloce (-2s), deterministico.\n' +
          'Svantaggi: minor copertura, no variazione linguistica (italiano vs inglese).\n' +
          'Use case: test rapidi, quando seedPrompt è già SuperOttimizzato.',
      },

      // ─── Performance ────────────────────────────────────────────────
      {
        key: 'validateTimeoutMs',
        label: 'Timeout HEAD validation (ms)',
        type: 'number',
        required: false,
        defaultValue: '5000',
        help:
          'HEAD request per filtrare siti morti. Accetta 200/405.\n' +
          '• 0 = disabilita validation (più veloce, meno qualità)\n' +
          '• 3000 = stretto (solo siti rapidissimi)\n' +
          '• 5000 = default bilanciato\n' +
          '• 10000 = tollerante (server lenti accettati)',
      },
    ],
    outputs: [
      'companies', // [{url, domain, title, snippet, source_provider, matched_query, boost_factors}]
      'urls', // string[] (shortcut per JSONata downstream)
      'queries_used', // string[]
      'queries_generated_by_llm', // boolean
      'llm_provider', // 'liara' | 'anthropic' | ... | null
      'total_raw_results', // number
      'filtered_directory', // number
      'filtered_validation', // number
      'took_ms', // number
      'count', // number
    ],
    outputContract: {
      notes: 'I due contatori `filtered_directory` e `filtered_validation` dicono quanti risultati sono stati SCARTATI: se `count` e` basso e quelli sono alti, il filtro sta lavorando piu` della ricerca.',
      fields: [
        { name: 'companies', type: 'array', desc: 'Le aziende trovate, con nome e sito.' },
        { name: 'urls', type: 'array', desc: 'I soli indirizzi dei siti, comodi da passare a un ciclo.' },
        { name: 'queries_used', type: 'array', desc: 'Le ricerche effettivamente eseguite.' },
        { name: 'queries_generated_by_llm', type: 'boolean', desc: 'Se le ricerche le ha scritte un modello invece che la configurazione.' },
        { name: 'llm_provider', type: 'string|null', desc: 'Il fornitore interpellato per generarle. Null se non e` servito.' },
        { name: 'total_raw_results', type: 'number', desc: 'Quanti risultati grezzi sono arrivati dal motore.' },
        { name: 'filtered_directory', type: 'number', desc: 'Quanti scartati perche` erano elenchi e non aziende.' },
        { name: 'filtered_validation', type: 'number', desc: 'Quanti scartati perche` non hanno superato i controlli.' },
        { name: 'took_ms', type: 'number', desc: 'Quanto ci ha messo.' },
        { name: 'count', type: 'number', desc: 'Quante aziende sono rimaste.' },
        { name: 'llm_usage', type: 'object', desc: 'Il consumo di token. Presente solo se e` stato interpellato un modello.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
