/**
 * Web tools action nodes — visual nodes per "fetch URL → testo leggibile"
 * e "ricerca sul web". Complementari al nodo `action_http` (v2 Federico-
 * grade): http è un client HTTP generico (auth picker, pagination, retry,
 * body modes); questi 2 sono task-oriented:
 *
 *   • action_fetch_url   — fetch + cheerio extract → solo testo principale,
 *     no script/style/nav, max 100KB. SSRF-guarded server-side.
 *   • action_web_search  — Brave Search API (env BRAVE_SEARCH_API_KEY) con
 *     DuckDuckGo HTML scraping come fallback always-on. Cache LRU 5min.
 *
 * Use case principale: workflow di scraping/monitoring/ricerca dove non
 * vuoi configurare auth/headers/parser manualmente. L'utente passa URL o
 * query e ottiene contenuto leggibile pronto per LLM/storage.
 *
 * Esecuzione: il NodeDef è isomorfo (browser-safe); l'executor reale è
 * server-side (vedi apps/runtime/src/executors/web-tools.ts) perché
 * cheerio/fetch DOM-strip non gira in browser editor.
 */
import type { NodeModule } from '../types.js';

export const fetchUrlNode: NodeModule = {
  def: {
    id: 'action_fetch_url',
    type: 'action',
    label: 'Web: Fetch URL → testo',
    icon: 'globe',
    color: '#06b6d4',
    description:
      'Scarica una pagina web e ne estrae SOLO il testo leggibile come stringa pulita per pipeline AI. Strip aggressivo via cheerio: rimuove <script>, <style>, <nav>, <footer>, <aside>, commenti HTML, white-space ridondante. Output ottimizzato per LLM prompt (token economy) o storage searchable, non per parsing strutturato.\n\n' +
      'Differenza con i sibling: action_fetch_url = quick text-only extraction zero-config (1 URL → 1 stringa). Per HTML completo con header browser-like + cookie jar usa action_web_fetch_advanced (più opzioni, più verbose). Per parsing strutturato con CSS selector usa action_html_select. Per scraping SPA JS-heavy usa action_browser_render (BYO). Per orchestrazione multi-stage adaptive con AI extract usa action_scrape_smart.\n\n' +
      'Limiti by-design (no surprise pricing/abuse): max 100 KB output (~25k token Claude — oltre il quale conviene split + summarize), timeout 10s connect+read, follow redirect max 5 hop, content-type filter (accetta solo text/html, application/xhtml — un binary mascherato da HTML viene rifiutato).\n\n' +
      'Sicurezza: SSRF-guarded via @medea/engine-safe-fetch (blocca 127.0.0.1, 10.x/172.16-31/192.168.x, link-local 169.254.x, IPv6 fc00::/7), User-Agent identifica FlowForge per audit-friendly upstream (rispetta robots.txt — un sito può bloccarci by-design). Audit log su ogni fetch con url + status + bytes per forensics e cost monitoring.\n\n' +
      'Use case: (1) iniettare contenuto landing-page competitor in prompt LLM per analisi posizionamento, (2) pre-processare FAQ pubblica della propria docs per indicizzazione RAG con embedding BGE-M3, (3) raccogliere testo articolo news per pipeline agent_summarizer + agent_classifier, (4) verifica SEO che la propria pagina prodotto contenga keyword target (text density check).\n\n' +
      'Safety budget: cap 100 KB protegge da abuso bandwidth, timeout 10s previene workflow hang, SSRF cap previene attacchi internal-network reconnaissance.',
    configFields: [
      {
        key: 'url',
        label: 'URL da scaricare',
        type: 'expression',
        required: true,
        placeholder: 'https://example.com/articolo',
        help: 'URL completa http:// o https://. SSRF guard attivo: host localhost/127.x.x.x/192.168.x.x/10.x.x.x bloccati. Supporta espressioni: {{$node.trigger.json.url}}.',
      },
      {
        key: 'maxBytes',
        label: 'Max bytes risposta (opzionale)',
        type: 'number',
        required: false,
        defaultValue: '100000',
        help: 'Default 100KB. Se la pagina è più grande, viene troncata. Output include `truncatedChars` per sapere quanto è stato tagliato.',
      },
    ],
    outputs: [
      'url',
      'finalUrl',
      'status',
      'title',
      'description',
      'content',
      'contentType',
      'truncatedChars',
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const webSearchNode: NodeModule = {
  def: {
    id: 'action_web_search',
    type: 'action',
    label: 'Web: Cerca sul web',
    icon: 'search',
    color: '#06b6d4',
    description:
      'Ricerca sul web con cascata 2-provider per high-availability senza vendor lock-in. Primary: Brave Search API (free tier 2k query/mese, ottima qualità per IT/EU SERP — richiede env BRAVE_SEARCH_API_KEY in vault tenant). Fallback: DuckDuckGo HTML scraping (gratis always-on, nessuna key, qualità leggermente inferiore ma sempre disponibile). Switch automatico su 429/5xx Brave.\n\n' +
      'Differenza con i sibling: action_web_search = SERP-style {title, url, snippet} structured (entry point discovery). Per cercare aziende verticali con LLM query expansion + anti-directory blocklist usa action_company_search (lead-gen). Per cercare email su un dominio già noto usa action_contact_discovery (crawler multi-path).\n\n' +
      'Output unificato indipendente dal provider: array di {title, url, snippet} normalizzato — un workflow downstream non deve sapere se sta consumando Brave o DDG. Cache LRU in-memory 5min per query identiche evita doppi hit su workflow batch ripetitivi (es. monitor giornaliero su 100 keyword).\n\n' +
      'Locale-aware: parametro country (IT/US/DE/...) influenza ranking (Brave) e localized HTML (DDG). Lingua auto-derivata dal locale tenant. Safe-search configurabile (off/moderate/strict).\n\n' +
      'Use case: (1) discovery siti vendor per cold outreach B2B con keyword verticali (input a action_company_search downstream), (2) raccolta news settimanale su parole chiave brand per digest management, (3) verifica menzioni competitor su SERP (alert se ranking scende), (4) primo step di pipeline RAG che poi fetcha top-N pagine con action_fetch_url + indicizza.\n\n' +
      'Safety budget: cap 50 risultati per query, timeout 10s per provider con fallback istantaneo, audit log con provider used + query hash + result count per cost monitoring Brave.',
    configFields: [
      {
        key: 'query',
        label: 'Query di ricerca',
        type: 'expression',
        required: true,
        placeholder: 'best practice webhook idempotency 2026',
        help: 'Stringa da cercare. Supporta espressioni: {{$node.trigger.json.topic}}.',
      },
      {
        key: 'limit',
        label: 'Numero risultati (1-20)',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Quanti risultati massimo. Brave: fino a 20; DuckDuckGo HTML: ~10 reali. Default 10.',
      },
    ],
    outputs: ['query', 'provider', 'results', 'count'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
