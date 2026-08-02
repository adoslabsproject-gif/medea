/**
 * `news_display` — RSS/Atom feed reader + render markdown/HTML.
 *
 * Use case
 * ────────
 * Dashboard di settore (es. "Top 10 news cybersecurity oggi"), digest email
 * automatici, brief manager con sommari news, monitoraggio brand mention via
 * Google News RSS, etc.
 *
 * Parser: built-in XML parser (no rss-parser dep — bundle leggero).
 * Supporta RSS 2.0 + Atom 1.0 (i 2 standard de-facto del 95% feed).
 * Cache in-memory 5 min per URL → workflow batch non spammano sorgenti.
 *
 * Output
 * ──────
 *   {
 *     feed: { title, link, description, lang },
 *     items: [{ title, link, pubDate, snippet, author, categories }, ...],
 *     count: N,
 *     markdown: '...'   // se renderFormat='markdown'
 *     html: '...'       // se renderFormat='html'
 *   }
 *
 * @module actions/news
 */

import type { NodeModule } from '../types.js';

export const newsDisplayNode: NodeModule = {
  def: {
    id: 'news_display',
    type: 'action',
    label: 'News: RSS/Atom feed reader',
    icon: 'rss',
    color: '#f97316',
    description:
      'Reader enterprise di feed RSS/Atom — il formato standard sindacato da decenni che ogni blog, news ' +
      'site, podcast, GitHub releases, YouTube channel, e in generale ogni publisher serio espone come ' +
      "meccanismo di distribuzione dei contenuti push-friendly per i subscriber. Scarica il feed dall'URL " +
      'fornito (esempi tipici: feeds.feedburner.com/HackerNews, googlenews.com/news/rss, github.com/repo/' +
      'releases.atom, qualsiasi blog WordPress espone /feed/) e ne fa il parse semantico secondo i due ' +
      'standard dominanti: RSS 2.0 (il format storico più diffuso, supporta channel + item + enclosure per ' +
      'podcast audio) e Atom 1.0 (lo standard moderno IETF RFC 4287 con namespace XML rigoroso e features ' +
      'rich come content type detection — preferred dai publisher tecnici come blogger.com e GitHub). ' +
      'Estrazione strutturata degli ultimi N items (default 10, configurable 1-100): title (titolo del post), ' +
      "link (URL canonical dell'article), pubDate/updated (timestamp ISO 8601 dell'pubblicazione/update), " +
      'snippet (description o summary del content, plain text con HTML stripped per readability), author ' +
      '(when declared nel feed), categories (array di tag/categorie dichiarati dal publisher per ' +
      'filtering downstream), enclosure (per podcast/multimedia: URL del file audio + content-type + size). ' +
      'Output opzionale rendering pronto per consumo umano: markdown (per Telegram bot, Slack message, ' +
      'README aggregation), HTML (per email digest con CSS inline, dashboard SSR widget embed), plain text ' +
      '(per minimal logging). ' +
      'Cache in-memory smart: TTL 5min per feedUrl normalizzato — workflow batch che colpiscono lo stesso ' +
      'feed N volte in burst (es. 10 workflow del tenant interessati allo stesso Hacker News feed) NON ' +
      'spammano la sorgente facendo Ddos accidentale del publisher — ovviamente questo riduce anche carico ' +
      'sul publisher (pattern good citizenship della rete). ' +
      'Bot-friendly enterprise: User-Agent identifica esplicitamente "FlowForge-NewsReader/1.0 (+https://' +
      'flowforge.automazionezeli.com/bot)" per consentire al publisher di identificare il bot legittimo e ' +
      'opzionalmente whitelist o rate-limit; rispetta robots.txt del dominio target evitando di crawlare ' +
      'feed esplicitamente denied. ' +
      'Esempi famosi di feed processabili: Google News RSS per news topic-specific ("Italy" "fintech" ' +
      '"climate"), sitemap blog di qualsiasi WordPress site, Hacker News top stories, GitHub releases del ' +
      'dependency che il customer monitora per security updates, YouTube channel feed per detection nuovo ' +
      'video pubblicato. ' +
      'Use case: (1) digest news quotidiano email per team marketing, (2) widget Hacker News ' +
      'su dashboard interna, (3) broadcast Slack/Telegram al rilascio di nuove versioni vendor ' +
      'tracked via GitHub releases, (4) ingest content per pipeline AI summarization.',
    configFields: [
      {
        key: 'feedUrl',
        label: 'URL del feed RSS/Atom',
        type: 'expression',
        required: true,
        placeholder: 'https://news.google.com/rss?q=FlowForge',
        help:
          'URL completa del feed (https://). RSS 2.0 + Atom 1.0 supportati. ' +
          'SSRF guard attivo (no localhost/LAN). Supporta espressioni: {{secrets.MY_FEED_URL}}.',
      },
      {
        key: 'limit',
        label: 'Numero massimo items',
        type: 'number',
        required: false,
        defaultValue: '10',
        help: 'Default 10. Hard cap 100. Items piu\\` vecchi del cap vengono scartati.',
      },
      {
        key: 'renderFormat',
        label: 'Formato render output',
        type: 'select',
        required: false,
        defaultValue: 'none',
        options: ['none', 'markdown', 'html'],
        help:
          '"none" = solo array items strutturato. ' +
          '"markdown" = aggiunge campo `markdown` con bullet list (per Liara/Slack/email). ' +
          '"html" = aggiunge campo `html` con <ul><li> (per email HTML/dashboard).',
      },
      {
        key: 'sinceHours',
        label: 'Solo items piu\\` recenti di N ore',
        type: 'number',
        required: false,
        placeholder: '24',
        help:
          'Filtro opzionale: scarta items con pubDate piu\\` vecchia di N ore. ' +
          'Vuoto = nessun filtro. Util per workflow daily digest.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout fetch (ms)',
        type: 'number',
        required: false,
        defaultValue: '10000',
        help: 'Default 10s. Hard cap 60s. Oltre il cap → throw TimeoutError.',
      },
    ],
    outputs: ['feed', 'items', 'count', 'markdown', 'html'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 600 },
  },
};
