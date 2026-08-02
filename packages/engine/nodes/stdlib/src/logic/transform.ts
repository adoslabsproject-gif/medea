import type { NodeModule, NodeExecutor } from '../types.js';
import { neutralizeCsvFormula } from '../lib/csv-formula-guard.js';
import { resolveDelimiter, type CsvDelimiter } from '../lib/csv-delimiter.js';
import { parseNumberLocale } from '../lib/number-locale.js';

/**
 * Convert node — JSON ↔ CSV ↔ XML ↔ YAML.
 * Lightweight implementations to avoid heavy deps; v2 will swap in `js-yaml`,
 * `csv-parse`, `fast-xml-parser` for stricter parsing.
 */

/** Opzioni di coercion delle celle CSV→JSON (opt-in: default = tutto stringa). */
interface CoerceOptions { numbers: boolean; booleans: boolean }

/**
 * Tokenizer CSV RFC 4180: gestisce campi quotati con il delimitatore, newline e
 * virgolette escapate (`""`) al loro interno. Char-by-char per non spezzare i
 * campi che contengono `\n`. Il delimitatore è parametrico (`,` `;` `\t`).
 */
function parseCsvRows(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let quoted = false; // true se il campo corrente conteneva una sezione quotata
  // RFC 4180: i campi QUOTATI preservano gli spazi; i non-quotati vengono trimmati
  // (comportamento atteso dal nodo convert). Il trim avviene al push del campo.
  const pushField = (): void => {
    row.push(quoted ? field : field.trim());
    field = '';
    quoted = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } // "" → " escapata
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; quoted = true; }
    else if (c === delimiter) pushField();
    else if (c === '\r') { /* normalizza CRLF */ }
    else if (c === '\n') { pushField(); rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length > 0 || quoted) { pushField(); rows.push(row); }
  return rows;
}

/**
 * Coercion di una cella: con `numbers` "42"/"1.234,56" → number (locale-aware,
 * SSOT number-locale); con `booleans` "true"/"false" (case-insensitive) → boolean.
 * Una cella che NON matcha resta stringa. La stringa vuota resta "" (mai 0/false).
 */
function coerceCell(raw: string, opts: CoerceOptions): unknown {
  if (raw === '') return '';
  if (opts.booleans) {
    const low = raw.toLowerCase();
    if (low === 'true') return true;
    if (low === 'false') return false;
  }
  if (opts.numbers) {
    const n = parseNumberLocale(raw);
    if (n !== null) return n;
  }
  return raw;
}

function parseCsv(text: string, delimiter: CsvDelimiter, coerce: CoerceOptions): Record<string, unknown>[] {
  // I campi sono già trimmati (se non-quotati) dal tokenizer → niente re-trim qui,
  // così gli header/valori quotati con spazi intenzionali restano intatti.
  const rows = parseCsvRows(text, delimiter).filter(
    (r) => !(r.length === 1 && (r[0] ?? '') === ''),
  );
  if (rows.length === 0) return [];
  const header = rows[0] ?? [];
  return rows.slice(1).map((cells) => {
    const row: Record<string, unknown> = {};
    header.forEach((col, idx) => {
      row[col] = coerceCell(cells[idx] ?? '', coerce);
    });
    return row;
  });
}

function toCsv(rows: Record<string, unknown>[], delimiter: CsvDelimiter): string {
  if (rows.length === 0) return '';
  // Header = unione ordinata delle chiavi di TUTTE le righe (first-seen order):
  // evita la perdita di colonne quando le righe sono oggetti eterogenei.
  const header: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        header.push(k);
      }
    }
  }
  // L'HEADER è composto da chiavi controllate dall'autore, ma una chiave può comunque
  // iniziare con un trigger di formula → neutralizzo anche le intestazioni (CWE-1236).
  const out = [header.map((h) => csvField(neutralizeCsvFormula(h), delimiter)).join(delimiter)];
  for (const row of rows) {
    out.push(header.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return '';
      // CWE-1236: una cella STRINGA che inizia con `= + - @`/TAB/CR è una formula
      // eseguibile all'apertura in Excel → prefisso apice (SSOT csv-formula-guard).
      // Solo le stringhe: i numeri/oggetti serializzati via JSON.stringify ("-5",
      // "{...}") non sono celle-formula e restano intatti — coerente con action_csv.
      const s = typeof v === 'string' ? neutralizeCsvFormula(v) : JSON.stringify(v);
      return csvField(s, delimiter);
    }).join(delimiter));
  }
  return out.join('\n');
}

/** Quoting RFC 4180: racchiude tra virgolette se la cella contiene il delimitatore, `"`, `\n` o `\r`. */
function csvField(s: string, delimiter: CsvDelimiter): string {
  return s.includes(delimiter) || /["\n\r]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

const convertExecutor: NodeExecutor = async (config, input, _context) => {
  const start = Date.now();
  const from = typeof config.from === 'string' ? config.from : 'json';
  const to = typeof config.to === 'string' ? config.to : 'json';
  const coerce: CoerceOptions = {
    numbers: config.parseNumbers === true || config.parseNumbers === 'true',
    booleans: config.parseBooleans === true || config.parseBooleans === 'true',
  };

  let parsed: unknown;
  switch (from) {
    case 'json': parsed = typeof input === 'string' ? JSON.parse(input) : input; break;
    case 'csv': {
      const csvText = typeof input === 'string' ? input : '';
      // 'auto' → rileva il delimitatore sul testo in ingresso (virgola/;/tab).
      parsed = parseCsv(csvText, resolveDelimiter(config.delimiter, csvText), coerce);
      break;
    }
    case 'text': parsed = String(input ?? ''); break;
    default: parsed = input;
  }

  let output: unknown;
  switch (to) {
    case 'json': output = parsed; break;
    // Per l'output 'auto' non ha un campione → resolveDelimiter('',…) ricade su virgola.
    case 'csv': output = Array.isArray(parsed) ? toCsv(parsed as Record<string, unknown>[], resolveDelimiter(config.delimiter, '')) : ''; break;
    case 'text': output = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2); break;
    default: output = parsed;
  }

  return { output, durationMs: Date.now() - start };
};

export const convertNode: NodeModule = {
  def: {
    id: 'logic_convert',
    type: 'logic',
    label: 'Convert (JSON ↔ CSV ↔ Text)',
    icon: 'shuffle',
    color: '#f59e0b',
    description:
      'Convertitore universale enterprise tra i tre formati di interscambio dati più comuni nei workflow ' +
      'business: JSON (la lingua franca delle API REST moderne e dei database NoSQL), CSV (lo standard de-facto ' +
      'per Excel/Google Sheets/SAP/SAGE/gestionali italiani e per l\'export verso commercialisti e analisti che ' +
      'non programmano), plain text. Conversioni bidirezionali complete (6 paths: ' +
      'JSON→CSV, JSON→text, CSV→JSON, CSV→text, text→JSON, text→CSV). XML e YAML pianificati per v2 (richiedono ' +
      'parser xmldom + js-yaml). ' +
      'CSV — delimitatore configurabile (virgola, punto-e-virgola che è lo standard dei gestionali italiani perché ' +
      'la virgola è il separatore decimale, oppure TAB per TSV) con auto-detect sulla prima riga quando lasci ' +
      '"auto"; tokenizer RFC 4180 reale (campi quotati che contengono il delimitatore, virgolette doppie escapate ' +
      '"", a-capo dentro un campo, terminatori LF/CRLF); neutralizzazione anti formula-injection (CWE-1236) delle ' +
      'celle e intestazioni che iniziano con = + - @. ' +
      'CSV→JSON — coercion dei tipi OPT-IN (default OFF, tutto stringa per non rompere chi si aspetta testo): con ' +
      '"Converti numeri" le celle numeriche diventano number, riconoscendo ANCHE il formato italiano "1.234,56" → ' +
      '1234.56; con "Converti booleani" le celle "true"/"false" diventano boolean. ' +
      'JSON→text usa pretty-print a 2 spazi. ' +
      'Output: il risultato della conversione (stringa CSV/text, oppure array/oggetto per JSON), ritornato come ' +
      'valore diretto dell\'output del nodo. ' +
      'Use case: trasformare risposta paginata JSON da API REST in CSV scaricabile dal cliente nella dashboard ' +
      'tenant (export "tutti i miei ordini ultimi 90gg"); normalizzare upload CSV di anagrafica clienti da ' +
      'commercialista in JSON per ingest in res.partner Odoo via action_odoo_rpc; export logs strutturati ' +
      'JSON da audit_log in CSV per analytics in Excel/Google Sheets del CFO; conversione legacy COBOL ' +
      'fixed-width text in JSON per ingest in stream di workflow modern; data interchange tra B2B partner che ' +
      'parlano CSV (il partner) e modern internal APIs (JSON).',
    configFields: [
      {
        key: 'from',
        label: 'Formato di input',
        type: 'select',
        required: true,
        options: ['json', 'csv', 'text'],
        defaultValue: 'json',
        help: 'Come è il dato in input. json = stringa JSON o oggetto già parsato. csv = stringa CSV (con header sulla prima riga). text = stringa qualsiasi.',
      },
      {
        key: 'to',
        label: 'Formato di output',
        type: 'select',
        required: true,
        options: ['json', 'csv', 'text'],
        defaultValue: 'csv',
        help: 'json = oggetto/array JS · csv = stringa CSV con header · text = stringa (auto-stringify per non-string).',
      },
      {
        key: 'delimiter',
        label: 'Delimitatore CSV',
        type: 'select',
        required: false,
        options: ['auto', ',', ';', '\\t'],
        defaultValue: 'auto',
        help: 'Separatore di colonna. auto = rileva tra virgola/punto-e-virgola/tab dalla prima riga (in lettura). In scrittura "auto" usa la virgola. Scegli ";" per i gestionali italiani, "\\t" per TSV.',
      },
      {
        key: 'parseNumbers',
        label: 'CSV→JSON: converti i numeri',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Off (default): ogni cella resta stringa. On: le celle numeriche diventano number, riconoscendo anche il formato italiano "1.234,56" → 1234.56. Le celle non numeriche restano stringa.',
      },
      {
        key: 'parseBooleans',
        label: 'CSV→JSON: converti i booleani',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Off (default): "true"/"false" restano stringhe. On: diventano boolean (case-insensitive).',
      },
    ],
    vendor: 'flowforge',
    version: '1.2.0',
  },
  executor: convertExecutor,
};

/**
 * Wait node — pause workflow until either a timer expires or an external
 * resume signal arrives (e.g. webhook callback).
 */
export const waitNode: NodeModule = {
  def: {
    id: 'logic_wait',
    type: 'logic',
    label: 'Wait',
    icon: 'pause-circle',
    color: '#f59e0b',
    description:
      'Operatore enterprise di sospensione del workflow flessibile che combina i pattern timer-based (delay ' +
      'temporizzato) e signal-based (wait-for-webhook-callback) in un\'unica primitiva configurable. Sospende ' +
      'l\'esecuzione fino a uno dei tre scenari: timer scaduto (mode=timer, configurazione durationMs ' +
      'identica a logic_delay), arrivo di una callback HTTP esterna (mode=webhook, configurazione signalName + ' +
      'authToken, identico semantically a logic_wait_signal), oppure la combinazione "either" early-exit ' +
      '(mode=either — riprende al PRIMO dei due eventi che accade, pattern hybrid timeout + signal critical ' +
      'per use case real-world dove "se l\'utente non conferma entro 24h prendiamo decisione automatica"). ' +
      'Il workflow è completamente suspended durante l\'attesa: zero consumo CPU/RAM, lo state è persistito ' +
      'in checkpoint del SQLite runtime, sopravvive a restart container per deploy o crash, scheduler centrale ' +
      'del portal riprende il workflow quando il timer scade o il webhook arriva. Cap di sicurezza configurable ' +
      'maxTimeoutMs default 30 giorni — pattern di safety per evitare workflow zombie che restano paused per ' +
      'sempre per signal mai arrivato. ' +
      'Mode timer — simple, deterministic, prevedibile: durationMs (range 1ms-30giorni), resume al expire ' +
      'esatto, output con ms effettivi attesi (può differire micro-secondi da nominal per scheduler precision); ' +
      'Mode webhook — signal_name come endpoint POST /signals/<name> con auth_token validation, payload JSON ' +
      'del POST disponibile nel resume output; ' +
      'Mode either — early-exit racing: timer + webhook armati simultanei, primo che firma fa resume + log ' +
      'di chi ha vinto, pattern critico per "approval con timeout business default" (esempio canonico: ' +
      'wait_for_approval_or_24h). ' +
      'Output al resume: { resumedBy ("timer" | "webhook"), durationMs effettivo, signalPayload? (se ' +
      'webhook), timeoutReached (bool se timer ha vinto in mode either) }. ' +
      'Use case: aspettare conferma utente prima di proseguire (mode=webhook → invia link conferma + aspetta ' +
      'click), pausa anti-rate-limit prima di chiamata API successiva (mode=timer 1s tra 100 chiamate batch), ' +
      'wait per propagazione DNS/cache CDN (mode=timer 30s prima di check post-invalidate), attesa di ' +
      'esecuzione async esterna con callback notify (mode=webhook per "il processing OCR di Vision Extract è ' +
      'completed e invia signal"), pattern approval con default (mode=either con webhook + 24h timer per ' +
      '"se il manager non risponde entro 24h auto-approva" in workflow finance enterprise).',
    configFields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        required: true,
        options: ['timer', 'webhook', 'either'],
        defaultValue: 'timer',
        help: 'timer = riprende dopo `durationMs` (default 60s). webhook = riprende quando arriva POST su `/api/v1/workflows/:wfId/wait-resume/:runId` (max attesa `maxWaitMs`). either = il primo dei due che scade vince (early-exit).',
      },
      {
        key: 'durationMs',
        label: 'Durata (ms) — per mode timer/either',
        type: 'number',
        required: false,
        defaultValue: '60000',
        help: 'Tempo di attesa in millisecondi. 1000=1s, 60000=1min, 3600000=1h, 86400000=24h. Hard cap engine: 7 giorni (604800000ms). Per attese > 7 giorni usa `trigger_cron` invece.',
      },
      {
        key: 'maxWaitMs',
        label: 'Max attesa (ms) — per mode webhook/either',
        type: 'number',
        required: false,
        defaultValue: '3600000',
        help: 'Timeout assoluto del webhook. Se nessuna callback arriva entro questo tempo il workflow riprende comunque (status=timeout). Default 1h. Protezione anti-leak: se l\'utente non clicca mai il link conferma, il workflow non resta sospeso per sempre.',
      },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

/**
 * Transform node — JSONata expression to reshape input.
 */
export const transformNode: NodeModule = {
  def: {
    id: 'logic_transform',
    type: 'logic',
    label: 'Transform (JSONata)',
    // n8n-speak: "Set"/"Edit Fields" → questo nodo.
    searchAliases: ['set', 'fields', 'edit'],
    icon: 'wand',
    color: '#f59e0b',
    description:
      'Operatore enterprise di trasformazione JSON dichiarativo basato su JSONata — il Domain-Specific ' +
      'Language standard IETF 2015 specializzato in trasformazione di documenti JSON arbitrari, alternativa ' +
      'più potente e leggibile a JSON Path/JMESPath/jq adottata da molte enterprise (IBM API Connect, Camel ' +
      'Quarkus, Logic App di Azure usano JSONata o varianti) per le sue capability di functional composable ' +
      'transformation in singolo espressione one-liner che equivarrebbero a 30+ righe di JavaScript imperativo. ' +
      'JSONata combina selectors XPath-like ($.users[role=admin].email), funzioni higher-order built-in ' +
      '(map, filter, reduce, sort, groupBy, distinct, sum, count, count, avg), template literal con string ' +
      'interpolation (\\\'Hello \\\\(name)\\\'), date arithmetic ($millis() - $toMillis(created_at)), conditional ' +
      'ternario potente (price > 100 ? "expensive" : "cheap"), object construction con projection ' +
      '({"name": full_name, "totalSpent": $sum(orders.total)}), nested traversal con preservation di context ' +
      '(parent.{child.{name, count(child.items)}}). ' +
      'Pattern d\'uso enterprise tipico: ristrutturare il JSON di response di un\'API esterna nel formato ' +
      'atteso dal nodo downstream, evitando di scrivere logic_run_js custom che sarebbe più verbose + meno ' +
      'auditable. ' +
      'Sandboxed enterprise execution: l\'engine JSONata è isolato via timeout di valutazione 5s (override env ' +
      'MEDEA_JSONATA_TIMEOUT_MS) + cap di profondità 500 (timeboxing ufficiale JSONata via callback ' +
      '__evaluate_entry/exit → kill di ricorsioni/loop non-terminanti = anti-DoS sulla CPU del container), ' +
      'pure function semantics (no side effect: JSONata non ha accesso a fetch/fs/process), output sempre ' +
      'JSON-serializable. ' +
      'Documentazione e playground ufficiale completi a https://jsonata.org dove l\'utente può sperimentare ' +
      'expression complesse con preview live prima di paste nel nodo FlowForge. Cheatsheet quick reference: ' +
      '$count(items) per conta, items[price>100].name per filter+select, $sum(orders.total) per aggregate ' +
      'sum, $reduce(nums, function($a,$b){$a+$b}) per custom reducer, $groupBy(orders, "customer_id") per ' +
      'gruppi, $sort(items, function($x,$y){$x.price < $y.price}) per ordering custom, items{$.category: ' +
      '$count($)} per object construction con dynamic keys. ' +
      'Use case: pulire payload di un webhook removendo campi inutili che inquinerebbero il context ' +
      'downstream (es. metadata, debug_info, internal_id); unificare formati eterogenei di provider diversi ' +
      'in una struttura comune (Stripe webhook + PayPal webhook + bonifico bancario → schema canonical ' +
      '{ amount, currency, customer_email, payment_method, paid_at }); aggregare array con filter+map+reduce ' +
      'in singola expression chained vs N nodi logic_loop + logic_aggregate; rename di campi (snake_case ' +
      'da REST API legacy → camelCase per ingest in DB del cliente che usa camelCase convention).',
    configFields: [
      {
        key: 'expression',
        label: 'Espressione JSONata',
        type: 'code',
        language: 'jsonata',
        required: true,
        placeholder: '{\n  "name": firstName & " " & lastName,\n  "ageNext": age + 1,\n  "topOrders": orders[total > 100].id\n}',
        help: 'Espressione JSONata applicata all\'intero payload `input`. Le funzioni built-in più usate: `$count()`, `$sum()`, `$average()`, `$map()`, `$filter()`, `$reduce()`, `$keys()`, `$lookup()`, `$merge()`, `$string()`, `$number()`, `$boolean()`, `$now()`, `$millis()`, `$fromMillis()`. Per debug: usa il playground su jsonata.org incollando l\'input reale di un run precedente.',
      },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};

/**
 * Pagination helper — calls a paginated API and aggregates all pages.
 */
export const paginateNode: NodeModule = {
  def: {
    id: 'logic_paginate',
    type: 'logic',
    label: 'Paginate (auto-aggregate)',
    icon: 'list-ordered',
    color: '#f59e0b',
    description:
      'Iteratore enterprise per REST API paginate che gestisce automaticamente la complessità del looping ' +
      'attraverso N pagine fino al recupero completo del dataset, aggregando tutti i risultati in un singolo ' +
      'array unificato. Le REST API moderne implementano almeno 4 schemi di paginazione mutuamente incompatibili ' +
      '(causa di frustrazione storica per chi le integra a mano): (1) cursor-based — la più moderna e scalabile, ' +
      'usata da Shopify, Stripe, GitHub v4 GraphQL — la response contiene un opaque cursor "abc123" che va ' +
      'passato come query string `?cursor=abc123` nella next request, fino a quando il cursor è null/missing; ' +
      '(2) page-number — il più semplice e usato da CMS WordPress, Magento, e legacy enterprise — la response ' +
      'porta total_pages oppure has_more, e si itera `?page=1`, `?page=2`, ..., `?page=N`; (3) offset-limit — ' +
      'il classico SQL OFFSET/LIMIT esposto come `?offset=0&limit=50`, `?offset=50&limit=50`, semplice ma ' +
      'inefficace su dataset grossi (offset 100k è O(N) sul server); (4) link-header — il pattern RFC 5988 ' +
      'usato da GitHub v3 REST e altri — la response header `Link: <url>; rel="next"` punta esplicitamente al ' +
      'next URL senza dover costruirlo manualmente. ' +
      'La strategia è ESPLICITA (la scegli nel dropdown, non c\'è auto-detect): per la maggior parte delle API ' +
      'sai già quale schema usano. Path JSON configurabile per estrarre l\'array dall\'envelope della response ' +
      '(es. "data", "results.records" per API nested). ' +
      'Safety cap: max pagine (default 100), max elementi totali (default 50k — protezione memoria), max durata ' +
      'totale (default 5 min — anti-stuck). Rate-limit aware: su HTTP 429 rispetta l\'header Retry-After (capped ' +
      'a 30s) e ritenta la stessa pagina fino a 3 volte. SSRF-safe (safe-outbound-fetch). ' +
      'Output: { items (array unificato), pages (pagine processate), totalCount (= items.length), requestsCount ' +
      '(fetch totali, inclusi i retry 429), truncated (true se un cap ha fermato l\'iterazione → mancano dati), ' +
      'finalCursor (ultimo cursore visto, solo strategy=cursor) }. ' +
      'Use case: scarica TUTTI gli ordini Shopify delle ultime 24h via cursor-based pagination con filtro ' +
      'updated_at_min (3000+ ordini su un sabato sera black friday → 60 pagine × 50 record → 4-6 minuti); ' +
      'tutti i contatti HubSpot del workspace (offset 100k+ record di customer database B2B per esportazione ' +
      'mensile); tutta la lista commenti GitHub di un repository per analytics community engagement (link-header); ' +
      'bulk export CRM Pipedrive senza scrivere il loop manuale a mano col rischio di off-by-one o ' +
      'cursor-stuck-in-loop; sync incremental Notion database dove vogliamo tutti i record cambiati dall\'ultimo ' +
      'cursor salvato in memory_note.',
    configFields: [
      {
        key: 'urlTemplate',
        label: 'URL template',
        type: 'text',
        required: true,
        placeholder: 'https://api.example.com/items?page={{page}}',
        help: 'Placeholder per strategia: {{page}} (page-number) · {{cursor}} (cursor) · {{offset}}+{{limit}} (offset-limit). link-header ignora il template dopo la prima pagina.',
      },
      {
        key: 'method',
        label: 'Metodo HTTP',
        type: 'select',
        required: true,
        options: ['GET', 'POST'],
        defaultValue: 'GET',
        help: 'GET = standard per API REST GraphQL paginate. POST = quando la pagina è nel body (alcune API enterprise come Salesforce Bulk). Per altri metodi usa `action_http` in un `logic_loop`.',
      },
      {
        key: 'headersJson',
        label: 'Headers HTTP',
        type: 'key-value',
        required: false,
        help: 'Header per ogni chiamata API. Esempi: `Authorization=Bearer {{secrets.API_TOKEN}}`, `Content-Type=application/json`, `Accept=application/vnd.api+json`. Tipico per API autenticate: imposta Bearer una volta, applicato a tutte le pagine.',
      },
      {
        key: 'pageStrategy',
        label: 'Strategia paginazione',
        type: 'select',
        required: true,
        options: ['page-number', 'cursor', 'offset-limit', 'link-header'],
        defaultValue: 'page-number',
        help: 'page-number = ?page=N · cursor = ?after=<token> · offset-limit = ?offset=N&limit=M · link-header = legge Link header RFC 5988.',
      },
      { key: 'dataPath', label: 'Percorso dati nella risposta', type: 'text', required: false, placeholder: 'data.items', help: 'Dot-notation per estrarre l\'array dalla risposta (es. data.items, results, payload.list).' },
      { key: 'cursorPath', label: 'Percorso cursore', type: 'text', required: false, placeholder: 'meta.next_cursor', help: 'Solo per strategy=cursor. Dove leggere il prossimo cursore nella risposta.' },
      { key: 'limit', label: 'Limit per pagina (offset-limit)', type: 'number', required: false, defaultValue: '50', help: 'Solo per strategy=offset-limit: dimensione pagina ({{limit}}). Lo stop scatta quando una pagina ritorna meno di "limit" elementi.' },
      { key: 'maxPages', label: 'Max pagine (safety)', type: 'number', required: false, defaultValue: '100', help: 'Limite hard per non chiamare API all\'infinito.' },
      { key: 'maxItems', label: 'Max elementi totali (safety)', type: 'number', required: false, defaultValue: '50000', help: 'Cap difensivo sulla memoria: oltre questo numero di elementi aggregati l\'iterazione si ferma (truncated=true).' },
      { key: 'maxDurationMs', label: 'Durata massima (ms, safety)', type: 'number', required: false, defaultValue: '300000', help: 'Tempo massimo totale di paginazione. Oltre → stop (truncated=true). Default 5 minuti.' },
    ],
    vendor: 'flowforge',
    version: '1.1.0',
  },
};
