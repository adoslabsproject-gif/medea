/**
 * Contact Discovery — mini-agente di crawling intelligente per scoperta contatti.
 *
 * Differenza dall'`action_email_harvest`:
 *   - `email_harvest` opera su 1 sola pagina HTML che gli passi.
 *   - `contact_discovery` parte da un URL homepage e NAVIGA attivamente il
 *     sito (homepage → /contatti → /about → sitemap.xml → DDG fallback) finché
 *     non trova almeno una email business valida.
 *
 * Comparable: Hunter.io, Apollo.io, Clay.ai, Phantombuster.
 *
 * Multi-lingua: vocabolario 14 lingue (IT/EN/DE/FR/ES/PT/NL/EL + scandi SE/NO/DK/FI/IS + HR).
 * Robots.txt: rispettato. Rate limit: 2 req/s per host. Cache LRU 7 giorni.
 * Zero LLM dependency: funziona con qualsiasi provider (Liara, Anthropic, OpenAI, ...).
 */
import type { NodeModule } from '../types.js';

export const contactDiscoveryNode: NodeModule = {
  def: {
    id: 'action_contact_discovery',
    type: 'action',
    label: 'Contatti: Crawler intelligente (14 lingue)',
    icon: 'search-check',
    color: '#10b981',
    description:
      'Mini-agente enterprise di contact discovery che parte da un URL homepage di una azienda e NAVIGA ' +
      'sistematicamente il sito web alla ricerca della email business più probabile, simulando il pattern ' +
      'di ricerca manuale che un sales rep usa quando esamina il prospect per identificare il contact ' +
      'point. Pipeline di navigation strutturata multi-fase: (1) crawl della homepage primaria con extraction ' +
      'di tutte le link visibili nel header/footer, (2) ricerca automatic delle "smart pages" tipiche per ' +
      'contact information — /contatti /contact /contact-us /chi-siamo /about /about-us /team /staff /' +
      'impressum (la pagina obbligatoria per legge tedesca con dati aziendali) /contattaci /legal /privacy ' +
      'con varianti multi-lingua del path, (3) parse del sitemap.xml ufficiale per discovery pagine dedicate ' +
      'non linkate dalla home, (4) fallback strategy via DuckDuckGo search restricted al dominio "site:acme.com ' +
      'contact email" per trovare pagine nascoste dalla navigation principale. ' +
      'Vocabolario multi-lingua nativo per riconoscere le label di pagine "contatti" in 14 lingue diverse: ' +
      'italiano (Contatti, Contattaci, Chi siamo, Lavora con noi), inglese (Contact, Contact Us, About, ' +
      'Team), tedesco (Kontakt, Impressum — obbligatorio per legge DE, Über uns, Team), francese (Contact, ' +
      'À propos, Équipe), spagnolo (Contacto, Acerca de, Equipo), portoghese (Contato, Sobre, Equipa), ' +
      'olandese (Contact, Over ons), greco (Επικοινωνία, Σχετικά), scandinavi svedese/norvegese/danese/' +
      'finlandese/islandese, croato (Kontakt). Coverage tipica EU + USA + qualche emerging market. ' +
      'Rispetta robots.txt scrupolosamente (un publisher può escludere /admin/ /login/ e qualsiasi path che ' +
      'NON vuole sia crawlato — il nodo skipa quei path), rate-limit 2 req/sec per host (good-citizen ' +
      'standard per non risultare aggressive scanner che il publisher considererebbe abuse), cache LRU 7 ' +
      'giorni per host normalizzato (workflow batch su 1000 lead della stessa azienda non ricrawlano la ' +
      'stessa azienda 1000 volte). ' +
      'Zero LLM dependency nel core algorithm — questo è un IMPORTANTE feature: il crawl è deterministico ' +
      '(stesso input → SEMPRE stesso output per audit + reproducibility), no costo per-token, no exposure di ' +
      'dati PII del prospect a provider LLM esterni (GDPR-friendly), no dipendenza da API rate-limit di LLM ' +
      'esterni. Il LLM si può aggiungere downstream per personalization come opt-in. ' +
      'Output: email primaria (la più probabile da contattare — typically person email > role-based info@), ' +
      'tutte le email trovate con confidence score, pagina specifica dove trovata (per audit trail), lista ' +
      'di path tentati (per debug se non trovate). ' +
      'Use case: lead-gen B2B con discovery deterministica zero-LLM-cost (loop su 1000 company URL → contact ' +
      'discovery → email validation MX → personalization → outreach); arricchimento CRM partendo solo dal ' +
      'dominio aziendale (un sales rep ha solo "@acme.com" → workflow → email reale del decision-maker); ' +
      'verifica audit-friendly che la propria pagina /contatti renda email crawlable per accessibility e ' +
      'SEO; outreach internazionale multi-lingua senza traduzioni manuali (German DACH market via Impressum ' +
      'detection); pre-flight check di lead lists comprate da broker (verifica che gli URL aziendali del ' +
      'lead db hanno effettivamente contact reali → cleansing del dataset acquistato).',
    configFields: [
      // ─── Input principale ──────────────────────────────────────────
      {
        key: 'homeUrl',
        label: 'URL homepage azienda',
        type: 'expression',
        required: true,
        placeholder: '{{loop.item}}  oppure  https://esempio.it',
        help:
          'URL della homepage. Il nodo scopre AUTONOMAMENTE le pagine contatti/about/team/impressum. ' +
          'Accetta sia URL fisso che espressione runtime (es. {{loop.item}} dentro un loop, {{$node.search.json.url}} dopo una ricerca).',
      },

      // ─── Crawl scope ───────────────────────────────────────────────
      {
        key: 'maxPages',
        label: 'Pagine massime per dominio',
        type: 'number',
        required: false,
        defaultValue: '5',
        help:
          'Hard cap di pagine visitate per dominio. ' +
          '• 3 = veloce, copre homepage + 2 contact pages (basso impatto)\n' +
          '• 5 = default bilanciato — homepage + 4 pagine prioritarie + sitemap\n' +
          '• 10 = approfondito, per siti grandi multi-lingua (es. cantieri internazionali)\n' +
          '• 20 = max raccomandato (oltre = abuse).',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout totale per dominio (ms)',
        type: 'number',
        required: false,
        defaultValue: '30000',
        help:
          'Timeout end-to-end per dominio. Esempi:\n' +
          '• 15000 (15s) — solo siti veloci\n' +
          '• 30000 (30s) — default, copre 95% dei siti business\n' +
          '• 60000 (60s) — per siti lenti (es. cantieri legacy con server vecchi)\n' +
          'Allo scadere ritorna risultati parziali (paths_tried popolato anche se 0 email).',
      },

      // ─── Comportamento crawling ────────────────────────────────────
      {
        key: 'respectRobots',
        label: 'Rispetta robots.txt (raccomandato)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'Se ON, legge /robots.txt del sito e SKIPPA i path Disallow. ' +
          '⚠️ Disabilitare SOLO per ragioni legittime (es. sito proprio in fase test). ' +
          'Crawling contro robots.txt è eticamente scorretto e PUÒ causare ban IP + responsabilità GDPR/CCPA.',
      },
      {
        key: 'ddgFallback',
        label: 'Fallback DuckDuckGo (raccomandato)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'Se ON, quando il crawling del sito non trova email, esegue una search DDG '
          + '`site:dominio.it contatti email` come ultimo tentativo. '
          + 'Aggiunge ~3s ma aumenta significativamente l\'hit rate (+15-20% in test).',
      },
      {
        key: 'followSitemap',
        label: 'Fetch sitemap.xml (raccomandato)',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help:
          'Se ON, cerca /sitemap.xml e /sitemap_index.xml. Estrae URL che contengono keyword contatti (contatti, contact, kontakt, ecc.) e li visita. '
          + 'Molti siti enterprise hanno la pagina contatti SOLO via sitemap (non linkata in homepage).',
      },

      // ─── Caching ───────────────────────────────────────────────────
      {
        key: 'bypassCache',
        label: 'Bypass cache (forza re-fetch)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help:
          'Se ON, ignora la cache LRU 7-giorni e ri-fetcha il dominio. ' +
          'Usare SOLO per:\n' +
          '• Testing / debugging\n' +
          '• Sito appena modificato (azienda ha pubblicato nuova pagina contatti)\n' +
          '• Cron mensile per refresh proattivo\n' +
          'Costo: +3-15s di rete per dominio.',
      },

      // ─── Output filtering (avanzato) ───────────────────────────────
      {
        key: 'minEmailConfidence',
        label: 'Confidence minima email (avanzato)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help:
          'Filtra email con confidence sotto la soglia. Scala 0-100. Esempi:\n' +
          '• 0 (default) = nessun filtro, accetta tutto\n' +
          '• 70 = solo email da regex pulito + mailto: + Cloudflare decode\n' +
          '• 90 = SOLO email da mailto: links (massima certezza)\n' +
          'Confidence assegnata: mailto=100, Cloudflare=95, HTML-entity=90, plain-text=80, obfuscated=70.',
      },
      {
        key: 'preferredLocalParts',
        label: 'Local-part prioritari (CSV, avanzato)',
        type: 'text',
        required: false,
        defaultValue: 'commerciale,sales,info,contact,contatti,vendite',
        help:
          'Lista CSV di local-part (la parte prima della @) da preferire per primary_email. ' +
          'La prima email trovata che matcha viene scelta. ' +
          'Default copre cold outreach B2B (commerciale/sales/info). ' +
          'Customizza per altri verticali: HR cerca "hr,recruiting,careers"; Tech cerca "tech,support,api".',
      },
      {
        key: 'maxConcurrentFetchPerHost',
        label: 'Richieste parallele per host (avanzato)',
        type: 'number',
        required: false,
        defaultValue: '2',
        help:
          'Rate limit: max richieste parallele verso UN dominio. ' +
          '• 1 = ultra-conservativo (per siti fragili)\n' +
          '• 2 = default bilanciato (good citizen)\n' +
          '• 4 = veloce ma più aggressivo (rischio rate-limit del target)\n' +
          'NON impatta multi-dominio: 100 domini diversi vengono fetchati in parallelo.',
      },
    ],
    outputs: [
      'emails',
      'primary_email',
      'source_page',
      'pages_visited',
      'paths_tried',
      'domain',
      'took_ms',
      'cache_hit',
      'has_emails',
      'reason_if_empty',
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};
