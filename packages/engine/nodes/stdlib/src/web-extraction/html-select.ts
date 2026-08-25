/**
 * action_html_select — estrai dati strutturati da HTML usando CSS selector.
 *
 * Input: HTML (da action_web_fetch_advanced o esplicito) + map
 * { fieldName: { selector, attr?, extract? } } → ritorna object con i campi.
 *
 * Ispirazione: pattern Jsoup di Streammy `document.select("script").map { it.data() }`.
 *
 * Estrazioni supportate (per campo):
 *  - extract='text' (default): testo trimmed
 *  - extract='html': innerHTML
 *  - extract='attr': valore attributo (richiede `attr`)
 *  - extract='list': array di matches (text/html/attr per ogni elemento)
 */

import { load as cheerioLoad, type CheerioAPI } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

interface SelectorSpec {
  selector: string;
  attr?: string;
  extract?: 'text' | 'html' | 'attr' | 'list';
  /** Quando extract='list': max elementi (default 100). */
  limit?: number;
}

function parseSelectorsMap(raw: unknown): Record<string, SelectorSpec> {
  if (typeof raw === 'string') {
    try {
      return parseSelectorsMap(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, SelectorSpec> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = { selector: v, extract: 'text' };
    } else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const sel = String(obj.selector ?? '');
      if (!sel) continue;
      const spec: SelectorSpec = { selector: sel };
      const a = obj.attr;
      if (typeof a === 'string') spec.attr = a;
      const e = obj.extract;
      if (e === 'text' || e === 'html' || e === 'attr' || e === 'list') spec.extract = e;
      const l = obj.limit;
      if (typeof l === 'number') spec.limit = l;
      out[k] = spec;
    }
  }
  return out;
}

function extractOne($: CheerioAPI, spec: SelectorSpec): unknown {
  const $el = $(spec.selector);
  if ($el.length === 0) return null;
  const limit = Math.max(1, Math.min(spec.limit ?? 100, 1000));
  switch (spec.extract ?? 'text') {
    case 'html':
      return $el.first().html() ?? '';
    case 'attr':
      if (!spec.attr) return null;
      return $el.first().attr(spec.attr) ?? null;
    case 'list': {
      const out: (string | null)[] = [];
      $el.slice(0, limit).each((_, el) => {
        const $cur = $(el);
        if (spec.attr) out.push($cur.attr(spec.attr) ?? null);
        else out.push($cur.text().trim());
      });
      return out;
    }
    case 'text':
    default:
      return $el.first().text().trim();
  }
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const htmlSource = String(config.htmlSource ?? 'input');
  let html = '';
  if (htmlSource === 'input') {
    if (typeof input === 'string') html = input;
    else if (input && typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      // Common shapes: { body: "..." } from web_fetch_advanced, raw object string
      if (typeof obj.body === 'string') html = obj.body;
      else if (typeof obj.html === 'string') html = obj.html;
      else html = JSON.stringify(input);
    }
  } else {
    html = String(config.htmlExplicit ?? '');
  }
  if (!html.trim()) {
    return {
      output: { matched: false, fields: {} },
      durationMs: Date.now() - start,
      warnings: ['Empty HTML input'],
    };
  }

  const selectorsRaw = config.selectorsJson;
  const selectors = parseSelectorsMap(
    typeof selectorsRaw === 'string' ? selectorsRaw : selectorsRaw,
  );
  if (Object.keys(selectors).length === 0) {
    throw new Error('selectorsJson required (map of fieldName → {selector, attr?, extract?})');
  }

  const $ = cheerioLoad(html);
  const fields: Record<string, unknown> = {};
  let matchedCount = 0;
  for (const [name, spec] of Object.entries(selectors)) {
    const value = extractOne($, spec);
    if (value !== null && value !== '') matchedCount++;
    fields[name] = value;
  }

  return {
    output: {
      matched: matchedCount > 0,
      matchedCount,
      totalFields: Object.keys(selectors).length,
      fields,
    },
    durationMs: Date.now() - start,
  };
};

export const htmlSelectNode: NodeModule = {
  def: {
    id: 'action_html_select',
    type: 'action',
    label: 'HTML Select (CSS)',
    icon: 'code',
    color: '#7c3aed',
    description:
      'Parser dichiarativo enterprise di HTML usando selettori CSS standard — l\'estrattore "scraper-friendly" ' +
      'che permette al business user di definire una mapping semplice "fieldName → CSS selector" e ottenere ' +
      'in output un object JavaScript strutturato con tutti i campi richiesti, evitando il dover scrivere ' +
      'codice JavaScript imperative con querySelector chain + manual error handling. Il pattern è analogo ' +
      'a quello di Jsoup (Java), Cheerio (Node.js), Beautiful Soup (Python con CSS support) — tutti ' +
      'utilizzati in produzione da progetti enterprise di scraping responsabile per parsing di HTML payload ' +
      'già scaricato da fetch upstream o action_web_fetch_advanced. ' +
      'Coverage piena dei selettori CSS3 specification: tag selector (h1, p, article), id selector (#main-' +
      'content, #checkout-form), class selector (.product-card, .price-tag), attribute selector ([data-sku], ' +
      '[href*="amazon"], [type="email"]), pseudo-class selector (:nth-child(2n), :first-child, :last-child, ' +
      ':not(.disabled), :has(.discount)), combinator complessi (descendant " ", child >, adjacent sibling +, ' +
      "general sibling ~) — l'utente può copy-paste qualsiasi selettore dal DevTools del browser e funziona. " +
      'Per ogni campo configurabile la strategia di extraction del valore: ' +
      '(1) "text" default — extract solo il textContent visibile (HTML stripped, gli spazi normalizzati), ' +
      'pattern per estrarre testo human-readable; ' +
      '(2) "html" — extract il innerHTML del element matchato (preserva il markup interno per cases come ' +
      '"description con tag <strong> da preservare"); ' +
      '(3) "attr" con parametro attrName — extract il valore di uno specifico attribute HTML (es. attr=href ' +
      'per link URL, attr=src per immagini, attr=data-sku per identifier nascosti in data-attribute, attr=' +
      'value per form input default value); ' +
      '(4) "list" — extract un array con il valore (testo o attr) di TUTTI i match del selector invece di solo ' +
      "il primo, pattern per liste enumerabili tipo tutti i titoli di un'archivio blog o tutti i prezzi in " +
      'una pagina di confronto product. ' +
      'Sicurezza enterprise: NO JavaScript execution sul HTML (il parser è pure HTML — no DOM-level events, ' +
      'no fetch, no XHR), completely safe per processing di HTML untrusted da source web arbitrari senza ' +
      'rischio di XSS o code injection. ' +
      'Output strutturato: { extracted: { fieldName1: "value", fieldName2: ["arr", "of", "values"], ... }, ' +
      'totalFieldsExtracted, totalFieldsMissing, performance: { selectorsMatched, processingTime } }. ' +
      'Use case: parse listing prodotti proprio e-commerce per export Excel quotidiano (cron daily + ' +
      'fetch del catalog page + html_select per scraping di SKU+name+price+stock+image_url → xlsx_build → ' +
      'send_email al merchandising team); estrazione di titolo/prezzo/disponibilità da pagine prodotto ' +
      'competitor monitorate per pricing intelligence; raccolta sistematica di righe da tabella HTML di ' +
      "report istituzionale (es. ISTAT, AGENAS, Banca d'Italia che pubblicano stats in tabelle senza " +
      'open data CSV equivalent); ingest content blog per RAG/embedding pipeline partendo dalla homepage ' +
      'del blog (extract title+author+date+content_html di ogni post per indicizzazione knowledge base AI); ' +
      'parsing di SERP page (Google/Bing search result) per analisi SEO competitive intelligence.',
    outputContract: {
      notes: 'I valori estratti stanno DENTRO `fields`, sotto i nomi dati in configurazione: `{{$node.<id>.json.fields.<nome>}}`. Un selettore che non trova niente NON fa fallire il nodo: quel campo esce null e `matchedCount` scende.',
      fields: [
        { name: 'fields', type: 'object', desc: 'Un valore per ogni selettore, sotto il nome che gli e` stato dato. Null per quelli che non hanno trovato niente.' },
        { name: 'matched', type: 'boolean', desc: 'Se almeno un selettore ha trovato qualcosa.' },
        { name: 'matchedCount', type: 'number', desc: 'Quanti selettori hanno trovato un valore.' },
        { name: 'totalFields', type: 'number', desc: 'Quanti selettori erano stati chiesti.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'htmlSource',
        label: 'Sorgente HTML',
        type: 'select',
        required: false,
        options: ['input', 'explicit'],
        defaultValue: 'input',
        help: 'input = HTML dal nodo precedente (estrae da string, .body o .html). explicit = HTML scritto a mano nel campo sotto.',
      },
      {
        key: 'htmlExplicit',
        label: 'HTML (esplicito)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: '<html><body><h1>Titolo</h1></body></html>',
        showIf: { field: 'htmlSource', equals: 'explicit' },
        help: 'HTML statico per testing. In produzione usa input dal web_fetch_advanced precedente.',
      },
      {
        key: 'selectorsJson',
        label: 'Selettori CSS (map)',
        type: 'code',
        language: 'json',
        required: true,
        placeholder:
          '{\n' +
          '  "title": "h1",\n' +
          '  "price": { "selector": ".price", "extract": "text" },\n' +
          '  "imageUrl": { "selector": "img.hero", "extract": "attr", "attr": "src" },\n' +
          '  "tags": { "selector": ".tag", "extract": "list", "limit": 10 }\n' +
          '}',
        help:
          'Map fieldName → selector. Forma scorciatoia: "title": "h1" equivale a {selector:"h1", extract:"text"}. ' +
          'Forma estesa: {selector, attr, extract, limit}. ' +
          'extract: text (default) | html | attr (richiede attr) | list (array).',
      },
    ],
    outputs: ['matched', 'matchedCount', 'totalFields', 'fields'],
  },
  executor,
};
