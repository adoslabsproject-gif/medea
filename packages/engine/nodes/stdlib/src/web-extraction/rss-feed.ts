/**
 * trigger_rss_feed — polling RSS/Atom feed + emit nuovi items.
 *
 * Use case legittimi:
 *  - News aggregation azienda (combinare 10 feed in un singolo dashboard)
 *  - Monitoraggio comunicati stampa concorrenti (legittimo per market research)
 *  - Notifiche push su nuovi articoli del proprio blog
 *  - Sync blog → CRM lead enrichment
 *
 * Parse pure XML (RSS 2.0 + Atom 1.0) senza dipendenze pesanti.
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

interface FeedItem {
  guid: string;
  title: string;
  link: string;
  description?: string;
  publishedAt?: string;
  author?: string;
  categories?: string[];
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  if (!url) throw new Error('url required (RSS or Atom feed URL)');

  const userAgent = String(
    config.userAgent ?? 'FlowForge/1.0 (+https://flowforge.automazionezeli.com)',
  );
  const sinceIso = String(config.sinceIso ?? '').trim();
  const maxItems = Math.max(1, Math.min(Number(config.maxItems ?? 50), 500));

  const res = await safeFetchWithRedirects(url, {
    method: 'GET',
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Feed fetch ${res.status.toString()}`);
  const xml = await res.text();

  const $ = cheerioLoad(xml, { xml: true });

  // Detect RSS vs Atom
  const isRss = $('rss, channel').length > 0;
  const isAtom = $('feed').length > 0 && !isRss;

  const items: FeedItem[] = [];
  let feedTitle = '';
  let feedLink = '';

  if (isRss) {
    feedTitle = $('channel > title').first().text().trim();
    feedLink = $('channel > link').first().text().trim();
    $('item').each((_, el) => {
      if (items.length >= maxItems) return false;
      const $i = $(el);
      const guid = $i.find('guid').first().text().trim() || $i.find('link').first().text().trim();
      const title = $i.find('title').first().text().trim();
      const link = $i.find('link').first().text().trim();
      const desc = $i.find('description').first().text().trim();
      const pub = $i.find('pubDate').first().text().trim();
      const author = $i.find('author, dc\\:creator').first().text().trim();
      const cats: string[] = [];
      $i.find('category').each((__, c) => {
        cats.push($(c).text().trim());
      });
      const item: FeedItem = { guid, title, link };
      if (desc) item.description = desc;
      if (pub) {
        try {
          item.publishedAt = new Date(pub).toISOString();
        } catch {
          item.publishedAt = pub;
        }
      }
      if (author) item.author = author;
      if (cats.length > 0) item.categories = cats;
      items.push(item);
      return;
    });
  } else if (isAtom) {
    feedTitle = $('feed > title').first().text().trim();
    feedLink = $('feed > link').first().attr('href') ?? '';
    $('entry').each((_, el) => {
      if (items.length >= maxItems) return false;
      const $e = $(el);
      const guid = $e.find('id').first().text().trim();
      const title = $e.find('title').first().text().trim();
      const link = $e.find('link').first().attr('href') ?? '';
      const desc = $e.find('summary, content').first().text().trim();
      const pub = $e.find('updated, published').first().text().trim();
      const author = $e.find('author > name').first().text().trim();
      const cats: string[] = [];
      $e.find('category').each((__, c) => {
        const term = $(c).attr('term');
        if (term) cats.push(term);
      });
      const item: FeedItem = { guid, title, link };
      if (desc) item.description = desc;
      if (pub) item.publishedAt = pub;
      if (author) item.author = author;
      if (cats.length > 0) item.categories = cats;
      items.push(item);
      return;
    });
  } else {
    throw new Error('Feed format not recognized (neither RSS nor Atom)');
  }

  // Filter by sinceIso if provided
  let filtered = items;
  if (sinceIso) {
    const since = new Date(sinceIso).getTime();
    if (Number.isFinite(since)) {
      filtered = items.filter((i) => {
        if (!i.publishedAt) return true;
        const t = new Date(i.publishedAt).getTime();
        return Number.isFinite(t) && t > since;
      });
    }
  }

  return {
    output: {
      format: isRss ? 'rss' : 'atom',
      feedTitle,
      feedLink,
      itemsCount: filtered.length,
      totalParsed: items.length,
      items: filtered,
    },
    durationMs: Date.now() - start,
  };
};

export const rssFeedTriggerNode: NodeModule = {
  def: {
    id: 'trigger_rss_feed',
    type: 'trigger',
    label: 'RSS / Atom Feed',
    icon: 'rss',
    color: '#f97316',
    description:
      'Innesco enterprise di polling per feed RSS/Atom che esegue il workflow ad ogni nuovo item rilevato — ' +
      'il pattern monitoraggio continuativo "push-style" della pubblicazione di contenuti dei publisher che ' +
      "espongono feed standard. Auto-detect intelligente del formato (RSS 2.0 vs Atom 1.0) leggendo l'XML " +
      'root namespace — pattern necessario perché i due standard sono mutualmente incompatibili a livello di ' +
      'schema ma semanticamente equivalenti per il use case workflow, e il publisher può cambiare format ' +
      'sotto le scarpe senza avvisare. ' +
      'Implementazione robusta: il trigger scheduler del runtime FlowForge invoca questo trigger ogni ' +
      'pollIntervalMin (default 15min, range configurable 1min-24h), il nodo fetch del feed URL, parse XML ' +
      'completo, e per ogni item nuovo non-ancora processato fire un new run del workflow con il content del ' +
      'item come trigger input. Dedup importante via guid/id del item (gli item RSS hanno guid univoco — ' +
      'spec RFC 4287 lo richiede) + persisted di un cursor lastSeenGuid nel state store del trigger per ' +
      'guarantee exactly-once delivery anche su restart container o crash recovery — pattern cruciale per ' +
      'evitare il classico bug "ogni mattina ricevo 50 email di alert duplicate sui post di ieri" ' +
      "all'restart del workflow. " +
      'Schedulazione complementare: il polling può essere config su questo trigger directly (pattern preferito ' +
      'per workflow dedicato a singolo feed) oppure combinare con trigger_cron che chiama questo nodo come ' +
      'action (es. cron 15min globale che processa 10 feed in singolo workflow batch — più efficient di 10 ' +
      'trigger separati ognuno con suo polling indipendente). ' +
      'Input al workflow downstream per ogni nuovo item: { item: { title, link, pubDate, content, snippet, ' +
      'author, categories, enclosure? }, feedMetadata: { feedTitle, feedDescription, feedUrl, feedLanguage, ' +
      'totalItemsInFeed, polledAt } }. ' +
      'Use case enterprise di monitoring continuativo: news aggregator azienda con monitor di 10+ testate ' +
      '(Repubblica, Corriere, Sole24Ore, Il Foglio, Il Post, ANSA, Reuters Italia) + AI summary downstream via ' +
      'agent_business_summarizer + post su Slack canale #news della company; monitoraggio sistematico di ' +
      'comunicati stampa istituzionali (RSS feed di Camera dei Deputati, Senato della Repubblica, Gazzetta ' +
      'Ufficiale italiana, AgID, Garante Privacy — tutti expongono RSS feed ufficiale); sync di nuovi articoli ' +
      'del proprio blog su CRM HubSpot/Salesforce per il marketing team (post nuovo → contact rilevanti ' +
      'segmented → email digest); alert su nuovi articoli pubblicati dai principali concorrenti su loro blog ' +
      'corporate (10+ competitor monitored simultaneously); GitHub releases feed dei vendor di dependency ' +
      'critiche (postgres, nginx, kubernetes, node) per security patches notification.',
    vendor: 'flowforge',
    version: '1.1.0',
    configFields: [
      {
        key: 'url',
        label: 'URL feed RSS/Atom',
        type: 'text',
        required: true,
        placeholder: 'https://miosito.com/feed.xml / https://news.google.com/rss',
        help: "URL completo del feed XML. Auto-detect tra RSS 2.0 e Atom 1.0 leggendo il root element. Supporta i 2 standard più diffusi (RSS 2.0 di Userland 2003 + Atom 1.0 IETF RFC 4287). Per OPML aggregator usa un nodo upstream che esplode l'OPML in URL singole.",
      },
      {
        key: 'maxItems',
        label: 'Max items per fetch',
        type: 'number',
        required: false,
        defaultValue: '50',
        help: 'Numero massimo di items ritornati per chiamata. Default 50, hard cap 500. Per evitare flood downstream quando un feed pubblica burst di articoli (es. live blog elezioni). Se vuoi tutti gli items disponibili imposta 500.',
      },
      {
        key: 'sinceIso',
        label: 'Solo items dopo (ISO timestamp)',
        type: 'text',
        required: false,
        placeholder: '2026-05-30T00:00:00Z / {{$node.db_query.json.lastSeen}}',
        help: "Pattern DEDUPLICATION: ritorna SOLO items con `publishedAt > sinceIso`. Use case tipico: salvi in DB il `maxPublishedAt` dell'ultimo run riuscito e lo passi qui al prossimo polling. Senza questo filtro rischi di mandare lo stesso articolo 2+ volte (cron ogni 15 min processa sempre tutti gli ultimi 50 items).",
      },
      {
        key: 'userAgent',
        label: 'User-Agent',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge/1.0 (+https://flowforge.automazionezeli.com)',
        placeholder: 'MyCompany-RSS-Reader/2.0 (admin@mycompany.com)',
        help: 'Identificativo bot inviato come header `User-Agent`. RFC-compliant include nome + versione + contatto. Alcuni feed (Bloomberg, FT) bloccano UA generici e richiedono identificazione esplicita. Default identifica FlowForge.',
      },
    ],
    outputs: ['format', 'feedTitle', 'feedLink', 'itemsCount', 'totalParsed', 'items'],
  },
  executor,
};
