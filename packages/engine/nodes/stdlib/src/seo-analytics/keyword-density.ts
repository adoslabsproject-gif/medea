/**
 * action_keyword_density — analisi keyword density + n-gram extraction.
 *
 * Pipeline: extract clean text from HTML → tokenize Unicode-aware → remove
 * stopwords (multi-lingua) → compute frequency for n-grams (1, 2, 3) →
 * sort + topK.
 *
 * Output utile per: audit on-page SEO ("sto rankando per la keyword giusta?"),
 * content-gap analysis vs competitors, suggestion AI per espansione contenuto.
 *
 * Zero network — pure analysis. Tollerante a HTML, plain text e PDF text.
 */

import { load as cheerioLoad } from 'cheerio';
import type { NodeModule, NodeExecutor } from '../types.js';

/** Cap anti-abuso sui target keyword (input utente illimitato). */
const MAX_TARGET_KEYWORDS = 200;
const MAX_TARGET_LEN = 200;
/** Cap difensivo anti-OOM/CPU sul numero di token analizzati. */
const MAX_TOKENS = 1_000_000;

// Stoplist comuni IT + EN. Lista volutamente compatta + estendibile via config.
const STOP_IT = new Set([
  'di',
  'a',
  'da',
  'in',
  'con',
  'su',
  'per',
  'tra',
  'fra',
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'una',
  'uno',
  'e',
  'ed',
  'o',
  'ma',
  'che',
  'non',
  'è',
  'sono',
  'sei',
  'siamo',
  'sei',
  'come',
  'più',
  'questo',
  'questi',
  'queste',
  'quello',
  'quelli',
  'quelle',
  'al',
  'allo',
  'alla',
  'agli',
  'alle',
  'del',
  'dello',
  'della',
  'dei',
  'degli',
  'delle',
  'dal',
  'dalla',
  'dai',
  'dalle',
  'nel',
  'nello',
  'nella',
  'nei',
  'negli',
  'nelle',
  'sul',
  'sullo',
  'sulla',
  'sui',
  'sugli',
  'sulle',
  'cui',
  'mi',
  'ti',
  'si',
  'ci',
  'vi',
  'se',
  'lui',
  'lei',
  'loro',
  'io',
  'tu',
  'noi',
  'voi',
  'ha',
  'hai',
  'ho',
  'abbiamo',
  'avete',
  'hanno',
  'molto',
  'poco',
  'troppo',
  'già',
  'ancora',
  'sempre',
  'mai',
  'anche',
  'invece',
  'quindi',
  'perché',
  'però',
  'cosa',
  'tutto',
  'tutti',
  'tutte',
  'altro',
  'altra',
  'altri',
  'altre',
  'suo',
  'sua',
  'suoi',
  'sue',
  'mio',
  'mia',
  'miei',
  'mie',
  'tuo',
  'tua',
  'tuoi',
  'tue',
  'nostro',
  'nostra',
  'nostri',
  'nostre',
  'vostro',
  'vostra',
  'vostri',
  'vostre',
  'fa',
  'fare',
  'così',
  'puoi',
  'può',
  'possono',
  'essere',
  'avere',
  'stato',
  'stata',
  'stati',
  'state',
]);

const STOP_EN = new Set([
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'while',
  'as',
  'because',
  'so',
  'than',
  'that',
  'this',
  'these',
  'those',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
  'must',
  'shall',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'about',
  'against',
  'between',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'from',
  'up',
  'down',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'it',
  'its',
  'they',
  'them',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'not',
  'only',
  'own',
  'same',
  'too',
  'very',
  's',
  't',
  'just',
]);

// Stoplist essenziali DE / FR / ES (articoli, preposizioni, congiunzioni, pronomi, ausiliari).
const STOP_DE = new Set([
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einen',
  'einem',
  'einer',
  'eines',
  'und',
  'oder',
  'aber',
  'nicht',
  'auch',
  'als',
  'wie',
  'wenn',
  'dann',
  'doch',
  'noch',
  'schon',
  'ist',
  'sind',
  'war',
  'waren',
  'sein',
  'haben',
  'hat',
  'hatte',
  'werden',
  'wird',
  'wurde',
  'ich',
  'du',
  'er',
  'sie',
  'es',
  'wir',
  'ihr',
  'mich',
  'dich',
  'sich',
  'uns',
  'euch',
  'in',
  'an',
  'auf',
  'zu',
  'mit',
  'von',
  'bei',
  'aus',
  'nach',
  'über',
  'unter',
  'für',
  'ohne',
  'im',
  'am',
  'zum',
  'zur',
  'vom',
  'beim',
  'dass',
  'man',
  'nur',
  'sehr',
  'mehr',
  'so',
]);
const STOP_FR = new Set([
  'le',
  'la',
  'les',
  'un',
  'une',
  'des',
  'du',
  'de',
  'au',
  'aux',
  'et',
  'ou',
  'mais',
  'donc',
  'ne',
  'pas',
  'plus',
  'que',
  'qui',
  'quoi',
  'dont',
  'où',
  'ce',
  'cette',
  'ces',
  'cet',
  'je',
  'tu',
  'il',
  'elle',
  'nous',
  'vous',
  'ils',
  'elles',
  'on',
  'me',
  'te',
  'se',
  'lui',
  'leur',
  'est',
  'sont',
  'était',
  'être',
  'avoir',
  'a',
  'ont',
  'avait',
  'fait',
  'faire',
  'dans',
  'sur',
  'sous',
  'pour',
  'par',
  'avec',
  'sans',
  'entre',
  'vers',
  'chez',
  'comme',
  'son',
  'sa',
  'ses',
  'mon',
  'ma',
  'mes',
  'ton',
  'ta',
  'tes',
  'notre',
  'votre',
  'leurs',
  'très',
]);
const STOP_ES = new Set([
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'de',
  'del',
  'al',
  'y',
  'o',
  'pero',
  'no',
  'sí',
  'que',
  'qué',
  'quien',
  'como',
  'cuando',
  'donde',
  'porque',
  'si',
  'más',
  'muy',
  'yo',
  'tú',
  'él',
  'ella',
  'nosotros',
  'vosotros',
  'ellos',
  'ellas',
  'me',
  'te',
  'se',
  'le',
  'les',
  'es',
  'son',
  'era',
  'ser',
  'estar',
  'está',
  'están',
  'haber',
  'ha',
  'han',
  'hay',
  'fue',
  'en',
  'con',
  'por',
  'para',
  'sin',
  'sobre',
  'entre',
  'hasta',
  'desde',
  'hacia',
  'su',
  'sus',
  'mi',
  'mis',
  'tu',
  'tus',
  'este',
  'esta',
  'estos',
  'estas',
  'ese',
  'esa',
  'lo',
]);

const STOPLISTS: Record<string, Set<string>> = {
  it: STOP_IT,
  en: STOP_EN,
  de: STOP_DE,
  fr: STOP_FR,
  es: STOP_ES,
};

function pickStoplist(lang: string, extra: string[]): Set<string> {
  const out = new Set<string>();
  const l = lang.toLowerCase();
  // 'auto'/'both' = IT+EN (default sicuro per il mercato target); altrimenti la lingua scelta.
  const langs = l === 'auto' || l === 'both' ? ['it', 'en'] : [l];
  for (const code of langs) for (const w of STOPLISTS[code] ?? []) out.add(w);
  for (const w of extra) out.add(w.trim().toLowerCase());
  return out;
}

function extractText(html: string): string {
  if (!/<\w/u.test(html)) return html; // plain text
  const $ = cheerioLoad(html);
  // Rimuovi boilerplate non-contenuto: script/style + chrome di navigazione (nav/footer/
  // header/aside) → la densità riflette il CONTENUTO, non il menù ripetuto su ogni pagina.
  $('script, style, noscript, template, nav, footer, header, aside').remove();
  return $('body').length > 0 ? $('body').text() : $.text();
}

function tokenize(text: string, stripAccents = false): string[] {
  let norm = text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[‘’“”]/gu, "'");
  // Accent-folding opzionale: NFD scompone le accentate in base+segno, poi rimuovo i
  // segni combinanti → "caffè"/"café"/"caffe" collassano (match approssimato).
  if (stripAccents) norm = norm.normalize('NFD').replace(/[̀-ͯ]/gu, '');
  norm = norm
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!norm) return [];
  return norm.split(' ').filter(Boolean);
}

function countNgrams(
  tokens: string[],
  n: number,
  stop: Set<string>,
  minLen: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (tokens.length < n) return counts;
  for (let i = 0; i <= tokens.length - n; i += 1) {
    const slice = tokens.slice(i, i + n);
    if (slice.some((t) => t.length < minLen)) continue;
    if (n === 1 && stop.has(slice[0]!)) continue;
    if (n > 1) {
      // Per n-gram > 1: scarta se PRIMO o ULTIMO token è stopword (frasi tipo "ed è")
      if (stop.has(slice[0]!) || stop.has(slice[slice.length - 1]!)) continue;
    }
    const key = slice.join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function topK(
  counts: Map<string, number>,
  k: number,
  totalTokens: number,
): { term: string; count: number; density: number }[] {
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.slice(0, k).map(([term, count]) => ({
    term,
    count,
    density: totalTokens > 0 ? Number(((count / totalTokens) * 100).toFixed(2)) : 0,
  }));
}

const executor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  // Pick source text
  let raw = '';
  if (typeof input === 'string') raw = input;
  else if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.body === 'string') raw = obj.body;
    else if (typeof obj.html === 'string') raw = obj.html;
    else if (typeof obj.text === 'string') raw = obj.text;
  }
  if (!raw) raw = String(config.textExplicit ?? '');
  if (!raw.trim()) {
    return {
      output: { totalTokens: 0, warnings: ['Empty input'] },
      durationMs: Date.now() - start,
      warnings: ['Empty input'],
    };
  }

  const lang = String(config.lang ?? 'auto');
  const stripAccents = config.stripAccents === true || config.stripAccents === 'true';
  const text = extractText(raw);
  let tokens = tokenize(text, stripAccents);
  // Cap difensivo anti-OOM/CPU: un documento gigantesco produrrebbe un array di token
  // sterminato (e n-gram quadratici sulle scansioni). Tronchiamo a MAX_TOKENS.
  const warnings: string[] = [];
  if (tokens.length > MAX_TOKENS) {
    warnings.push(`Testo troncato a ${String(MAX_TOKENS)} token (cap anti-OOM)`);
    tokens = tokens.slice(0, MAX_TOKENS);
  }
  const customStopRaw = String(config.customStop ?? '');
  const extraStop = customStopRaw ? customStopRaw.split(/[\s,]+/u).filter(Boolean) : [];
  const stop = pickStoplist(lang, extraStop);
  const minLen = Math.max(1, Math.min(Number(config.minLen ?? 3), 10));
  const topN = Math.max(1, Math.min(Number(config.topN ?? 25), 200));

  const uni = topK(countNgrams(tokens, 1, stop, minLen), topN, tokens.length);
  const bi = topK(countNgrams(tokens, 2, stop, minLen), topN, tokens.length);
  const tri = topK(countNgrams(tokens, 3, stop, minLen), topN, tokens.length);

  // Targeted keyword search (opzionale)
  const targetRaw = String(config.targetKeywords ?? '').trim();
  const targetMap: { term: string; count: number; density: number }[] = [];
  if (targetRaw) {
    // Cap su numero target (e lunghezza per-target sotto) — input utente illimitato →
    // O(targets × testo) di scansioni. 200 keyword coprono ogni use-case SEO reale.
    const targets = targetRaw
      .split(/[,;\n]/u)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, MAX_TARGET_KEYWORDS);
    const fullText = tokens.join(' ');
    for (const tgt of targets) {
      if (!tgt || tgt.length > MAX_TARGET_LEN) continue;
      // count occurrences (whole-token sequence match) — stesso accent-folding del testo
      const tgtTokens = tokenize(tgt, stripAccents);
      if (tgtTokens.length === 0) continue;
      // `new RegExp` INTENZIONALE (non safeUserRegex/RE2): il pattern è MACCHINA-costruito da
      // token escaped (`replace([.*+?…])`) uniti da `\s+` + ancore → struttura LINEARE, niente
      // quantificatori annidati = ReDoS impossibile by-construction. RE2 qui NON va: il
      // lookahead `(?=\s|$)` (match whole-word non-consumante, per occorrenze adiacenti) NON è
      // supportato da RE2. La regola "safeUserRegex" vale per pattern AUTORE-forniti, non per
      // pattern interni su literali escaped.
      const re = new RegExp(
        `(?:^|\\s)${tgtTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+')}(?=\\s|$)`,
        'gu',
      );
      const matches = fullText.match(re);
      const count = matches?.length ?? 0;
      targetMap.push({
        term: tgt,
        count,
        density: tokens.length > 0 ? Number(((count / tokens.length) * 100).toFixed(2)) : 0,
      });
    }
  }

  return {
    output: {
      totalTokens: tokens.length,
      uniqueTokens: new Set(tokens).size,
      stoplistSize: stop.size,
      lang,
      unigrams: uni,
      bigrams: bi,
      trigrams: tri,
      targetKeywords: targetMap,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    durationMs: Date.now() - start,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

export const keywordDensityNode: NodeModule = {
  def: {
    id: 'action_keyword_density',
    type: 'action',
    label: 'Keyword Density (n-gram + stoplist)',
    icon: 'chart',
    color: '#9333ea',
    description:
      'Analizzatore di densità keyword da testo o HTML — estrae testo pulito (rimuove ' +
      'script/style/noscript + nav/footer/header/aside, così la densità riflette il ' +
      'contenuto e non il menù ripetuto), tokenizza Unicode-aware (accenti preservati, ' +
      'con accent-folding opzionale), rimuove le stopword built-in della lingua scelta ' +
      '(IT/EN/DE/FR/ES) + una blocklist custom. Calcola la frequenza per unigrammi, ' +
      'bigrammi (2 parole) e trigrammi (3 parole). Campo `targetKeywords` per misurare ' +
      'DIRETTAMENTE la densità di una o più frasi da monitorare (whole-token match).\n\n' +
      'Differenza con i sibling: action_keyword_density = frequency analysis ' +
      '(text → top-N keywords + custom target check). Per scoring SEO complessivo ' +
      'usa action_seo_audit (incorpora density nei criteri). Per estrarre solo meta ' +
      'tag senza analisi testo usa action_meta_extract. Per estrazione AI semantic ' +
      '(invece di frequency stat) usa agent_extractor.\n\n' +
      'Tokenization Unicode-aware: split su confine `\\p{L}\\p{N}`, lowercase + NFC. ' +
      'Accent-folding OPZIONALE (stripAccents): NFD + rimozione dei segni combinanti → ' +
      '"caffè"/"café"/"caffe" collassano (match approssimato). Lunghezza minima token ' +
      'configurabile (default 3, anti-rumore tipo "in/di/le").\n\n' +
      'Output: `{ totalTokens, uniqueTokens, stoplistSize, lang, unigrams: [{ term, ' +
      'count, density }], bigrams: [...], trigrams: [...], targetKeywords: [{ term, ' +
      'count, density }] }`. Density = count / totalTokens * 100 (%). Target SEO sano: ' +
      'keyword principale 1-3% (oltre = stuffing penalty). Cap difensivo 1M token.\n\n' +
      'Use case Cappella-Sistina-grade: (1) **audit on-page SEO post-publish** — ' +
      'verifico che la mia landing "piano marketing 2026" abbia density 1-3% sul ' +
      'target keyword, alert se under-optimized; (2) **content-gap analysis vs ' +
      'competitor** — scrap 5 SERP top + keyword_density su ognuno → media keyword ' +
      'usato + delta vs mia pagina = lista keyword da aggiungere; (3) **AI ' +
      'suggestion semantic expansion** — top-20 keyword density usato come input ' +
      'a LLM per suggerire bigrami correlati che mancano (LSI keywords); (4) ' +
      '**analytics editoriale** mensile — tutti articoli blog → trend keyword nel ' +
      'tempo (quale topic dominante questo trimestre?).\n\n' +
      'Safety budget: token cap 1M (oltre = truncate con warning), target keyword cap ' +
      '200, regex target machine-built (lineare, no ReDoS). Audit log con totalTokens + ' +
      'density top-3 per cost monitoring.',
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'textExplicit',
        label: 'Testo o HTML (esplicito, se non viene dal nodo precedente)',
        type: 'code',
        language: 'json',
        required: false,
        placeholder: 'Lascia vuoto per usare body/html/text dal nodo precedente.',
        help: 'Usato solo se il nodo precedente non passa testo. In produzione collega un Web Fetch o un Read File.',
      },
      {
        key: 'lang',
        label: 'Lingua stoplist',
        type: 'select',
        required: false,
        options: ['auto', 'it', 'en', 'de', 'fr', 'es', 'both'],
        defaultValue: 'auto',
        help: 'auto/both = IT+EN (default sicuro). it/en/de/fr/es = stoplist della singola lingua. Per altre lingue usa "Stopwords aggiuntive".',
      },
      {
        key: 'customStop',
        label: 'Stopwords aggiuntive (comma o newline)',
        type: 'text',
        required: false,
        placeholder: 'azienda, cliente, prodotto',
        help: 'Aggiungi parole specifiche del tuo dominio da escludere (es. brand name che inflaziona la classifica).',
      },
      {
        key: 'stripAccents',
        label: 'Accent-folding (caffè = caffe)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Off (default): "caffè" e "caffe" sono token distinti. On: rimuove gli accenti prima di contare → match approssimato (utile per testo con accentazione incoerente).',
      },
      {
        key: 'minLen',
        label: 'Lunghezza minima token',
        type: 'number',
        required: false,
        defaultValue: '3',
        help: 'Esclude token con meno di N caratteri (default 3, min 1, max 10).',
      },
      {
        key: 'topN',
        label: 'Top N risultati per gruppo',
        type: 'number',
        required: false,
        defaultValue: '25',
        help: 'Quanti risultati ritornare per unigrammi, bigrammi, trigrammi (max 200).',
      },
      {
        key: 'targetKeywords',
        label: 'Keyword target (1 per riga o virgola)',
        type: 'text',
        required: false,
        placeholder: 'workflow automation\nai agent\nintegrazione webhook',
        help: 'Se specificate, ritorna count + density per ognuna di queste frasi (whole-token match).',
      },
    ],
    outputs: [
      'totalTokens',
      'uniqueTokens',
      'stoplistSize',
      'lang',
      'unigrams',
      'bigrams',
      'trigrams',
      'targetKeywords',
    ],
  },
  executor,
};
