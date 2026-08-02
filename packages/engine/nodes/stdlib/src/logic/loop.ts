import type { NodeModule } from '../types.js';

/**
 * Loop — iterate a collection through a body sub-graph N times.
 *
 * Strategy-based iteration engine (n8n only has naive "SplitInBatches"):
 *
 *  • naive      — one item at a time, body sub-graph re-runs N times.
 *                 Best for: <50 items, side-effects that must serialize.
 *  • batch      — items grouped into chunks of `batchSize`. Body runs
 *                 K times where K = ceil(N/batchSize); each iteration
 *                 receives an ARRAY (chunk) as input.item.
 *                 Best for: APIs without bulk endpoints but with paging.
 *  • bulk       — body runs ONCE with the ENTIRE array. Use this only
 *                 when the downstream node supports a real bulk endpoint
 *                 (declares `bulk: { supports: true }` in its NodeDef).
 *                 Best for: Stripe.charges.bulk, DB COPY, S3 multipart.
 *  • queue      — items enqueued to BullMQ; workers consume async. The
 *                 workflow returns immediately ({queueId, accepted: N}).
 *                 Best for: 10k+ items, long-running per-item work.
 *  • aggregate  — body NOT executed; the array is grouped+reduced and
 *                 the reduced output is forwarded as a single item to
 *                 the `done` branch. Best for: SUM/COUNT/AVG roll-ups.
 *  • auto       — engine chooses based on size + downstream metadata:
 *                   N < 50 → naive
 *                   downstream has bulk capability → bulk
 *                   downstream rate-limited → batch with chunk = limit
 *                   N > 10k → queue
 *
 * Output (on `done` branch):
 *   {
 *     iterations: number,
 *     succeeded: number,
 *     failed: number,
 *     skipped: number,
 *     results: unknown[],          // one entry per iteration
 *     errors: Array<{index, message}>,
 *     totalDurationMs: number,
 *     strategy: string,            // strategy actually used
 *   }
 *
 * Per-iteration scope exposed to body nodes:
 *   {{ loop.item }}    — current item (or chunk array if strategy='batch')
 *   {{ loop.index }}   — 0-based index (chunk index if batch)
 *   {{ loop.total }}   — total iterations the engine will run
 *   {{ loop.first }}   — true on first iteration
 *   {{ loop.last }}    — true on last iteration
 */
export const loopNode: NodeModule = {
  def: {
    id: 'logic_loop',
    type: 'logic',
    label: 'Loop',
    // n8n-speak: "Split In Batches" → questo nodo.
    searchAliases: ['split', 'batches'],
    icon: 'repeat',
    color: '#f59e0b',
    description:
      'Operatore di iterazione enterprise — il workhorse di tutte le pipeline batch del workflow business. ' +
      'Itera una collezione (array di oggetti, object con key=>value, string split per character/word/line) ' +
      'attraverso il ramo "body" del workflow editor, applicando per ogni item la stessa sequenza di azioni ' +
      'configurate downstream. Equivalente concettuale del `for-each` dei linguaggi di programmazione classici ' +
      'ma con cinque strategie di esecuzione configurabili per coprire spettro completo dei use case da 10 ' +
      'item a 10M item: ' +
      '(1) naive — 1-at-a-time sequenziale, semplice e prevedibile, default per dataset < 100 item dove la ' +
      'latency totale del workflow non è blocker e ogni step può essere debugged singolarmente; ' +
      '(2) batch — chunk di N item alla volta (es. 50 per batch), pattern bilanciato per dataset 1k-10k item ' +
      'dove il throughput è importante ma vogliamo ancora controllo granular dei chunks per error handling; ' +
      "(3) bulk — UNA singola call downstream con l'array intero come input, pattern critico quando il nodo " +
      'downstream supporta operazioni bulk (es. action_email_send_tracked_batch, db_insert bulk) — riduce ' +
      'overhead di N invocazioni separate; ' +
      '(4) queue — processing asincrono via BullMQ (Redis/Dragonfly) per dataset > 10k item, attivo SE il ' +
      'worker BullMQ è in esecuzione (processo `flowforge worker`); se nessun worker è attaccato, il loop ricade ' +
      'automaticamente su naive (con log esplicito) — nessun dato perso, solo throughput ridotto; ' +
      "(5) aggregate — modalità riduzione senza body (no iteration steps), equivalente a passare l'array a " +
      'logic_aggregate downstream senza per-item processing; ' +
      "(6) auto — l'engine FlowForge sceglie automaticamente la strategy migliore basata su array size + " +
      'downstream node capabilities introspection. ' +
      "Scope expression per ogni iteration espone variabili context al body: {{loop.item}} (l'item corrente " +
      "dell'iterazione), {{loop.index}} (0-based position), {{loop.total}} (size della collezione), " +
      '{{loop.first}} (boolean true per il primo item, utile per email header decoration "Ciao {{name}}!" solo ' +
      'la prima volta), {{loop.last}} (boolean true per l\'ultimo, per email footer "fine elenco"), ' +
      '{{loop.percentage}} (per progress reporting). ' +
      'Branch outputs del nodo per error handling: "done" (success aggregato — tutti gli iter completati ' +
      'senza error), "error" (almeno 1 iteration ha fallito — il caller può vedere quali in failedItems). Cap ' +
      'configurable maxIterations (default 10000) per safety anti-runaway. ' +
      'Use case: process batch ordini Stripe webhook ricevuti via paginate → loop con strategy=batch per ' +
      "gestire 500 ordini in batch 50; parse righe CSV/Excel uploaded → loop su rows dell'output xlsx_parse " +
      'con strategy=naive per debug step-by-step; enrich N lead CRM con dati esterni via action_company_search ' +
      '+ action_lead_score (strategy=batch 10 per gestire rate-limit upstream); multi-recipient email con ' +
      'personalization per ogni destinatario; bulk insert in DB di analytics events con strategy=bulk per ' +
      'one-shot db_insert atomic.',
    configFields: [
      {
        key: 'itemsExpression',
        label: 'Espressione array da iterare',
        type: 'expression',
        required: true,
        placeholder: 'input.records',
        help: 'Espressione JS che ritorna un array. Esempi: input.orders · input.rows · [1,2,3,4,5] · Object.values(input) · input.text.split("\\n")',
      },
      {
        key: 'strategy',
        label: 'Strategia di iterazione',
        type: 'select',
        required: true,
        defaultValue: 'naive',
        options: ['naive', 'batch', 'bulk', 'queue', 'aggregate', 'auto'],
        help: "naive = uno alla volta (semplice). batch = in chunk (più veloce). bulk = singola chiamata bulk (se l'API supporta). queue = asincrono via BullMQ. aggregate = solo riduzione (no body). auto = engine sceglie il meglio.",
      },
      {
        key: 'batchSize',
        label: 'Dimensione chunk',
        type: 'number',
        required: false,
        defaultValue: '100',
        help: 'Item per chunk. Solo per strategia "batch". Es. 100 = processa 100 alla volta.',
        showIf: { field: 'strategy', equals: 'batch' },
      },
      {
        key: 'concurrency',
        label: 'Concorrenza (iterazioni in parallelo)',
        type: 'number',
        required: false,
        defaultValue: '1',
        help: "1 = seriale (un'iterazione alla volta). N = fino a N iterazioni in parallelo. 0 = illimitato (sconsigliato). Cap massimo = 50.",
      },
      {
        key: 'errorPolicy',
        label: 'Politica di gestione errori',
        type: 'select',
        required: false,
        defaultValue: 'continue',
        options: ['stop', 'continue', 'dlq'],
        help: "stop = ferma il loop al primo errore. continue = registra l'errore e prosegue. dlq = push in dead-letter queue per retry differito.",
      },
      {
        key: 'rateLimitPerMin',
        label: 'Rate limit (richieste/minuto)',
        type: 'number',
        required: false,
        defaultValue: '0',
        help: "Throttle a N iterazioni al minuto. 0 = nessun limite. Usa quando l'API a valle ha rate limit noto (es. 60 per Stripe gratis).",
      },
      {
        key: 'maxItems',
        label: 'Limite massimo iterazioni (safety)',
        type: 'number',
        required: false,
        defaultValue: '100000',
        help: "Hard cap anti-runaway. Se l'array supera questa soglia, l'engine solleva errore. 100k default è sicuro per la maggioranza dei casi.",
      },
      {
        key: 'aggregateBy',
        label: 'Campo group-by (aggregate)',
        type: 'text',
        required: false,
        placeholder: 'es. customer_id, category, region',
        help: "Nome del campo dell'item su cui raggruppare prima di ridurre. Es. items=[{customer_id:1,amount:10},{customer_id:1,amount:20}] con aggregateBy=customer_id raggruppa i 2 elementi.",
        showIf: { field: 'strategy', equals: 'aggregate' },
      },
      {
        key: 'aggregateReducer',
        label: 'Funzione di riduzione',
        type: 'select',
        required: false,
        defaultValue: 'count',
        options: ['count', 'sum', 'avg', 'min', 'max', 'concat', 'collect'],
        help: 'count = conta elementi del gruppo. sum/avg/min/max = applica al campo "aggregateField" sotto. concat = join stringhe. collect = ritorna array di item.',
        showIf: { field: 'strategy', equals: 'aggregate' },
      },
      {
        key: 'aggregateField',
        label: 'Campo per sum/avg/min/max',
        type: 'text',
        required: false,
        placeholder: 'es. amount, quantity, price',
        help: 'Nome del campo numerico da sommare/mediare. Ignorato per count/concat/collect. Es. con sum e aggregateField=amount, il risultato è la somma di tutti gli amount del gruppo.',
        showIf: { field: 'strategy', equals: 'aggregate' },
      },
    ],
    outputs: ['body', 'done'],
    branching: true,
    vendor: 'flowforge',
    version: '2.0.0',
  },
};

export const mergeNode: NodeModule = {
  def: {
    id: 'logic_merge',
    type: 'logic',
    label: 'Merge: Unisci branch paralleli',
    // n8n-speak: "Join" → questo nodo.
    searchAliases: ['join'],
    icon: 'git-merge',
    color: '#f59e0b',
    description:
      'Operatore di fan-in/join enterprise che combina gli output di N nodi paralleli upstream in un singolo ' +
      'output strutturato — la primitiva fondamentale di tutte le architetture fan-out + fan-in del workflow ' +
      'orchestration moderno (Airflow XCom, Temporal Workflow, AWS Step Functions Parallel). Quando hai 3-10 ' +
      "rami che girano in parallelo per ottimizzare il tempo totale dell'esecuzione (es. 3 search API " +
      'simultanei invece di sequenziali = 3× speedup), prima del passo successivo devi necessariamente unire ' +
      'i risultati in una struttura unica processabile — questo nodo lo fa con strategia configurabile per i ' +
      '4 pattern di merge più comuni nei workflow business. ' +
      'Il merge è un fan-in che gira DOPO che i branch upstream sono completati (non controlla la loro ' +
      'esecuzione parallela). Quattro strategie: ' +
      'Strategia "all" — mappa output di ogni branch alla sua nodeId di provenienza: { branches: { ' +
      '"search_google": …, "search_bing": … }, branchCount } — il pattern più strutturato che preserva origin. ' +
      'Strategia "concat-arrays" — ogni branch ritorna un array (o una sua sub-property configurabile via ' +
      '"arrayProperty", default "results"), concatenati in uno solo: { results: [...], branchCount, totalItems }. ' +
      'Strategia "any"/"first" — usa l\'output del PRIMO branch in ordine di sorgente (idx più basso); ritorna ' +
      'quell\'output direttamente (fallback semplice, NON racing: i branch sono già eseguiti). Strategia "last" — ' +
      "usa l'output dell'ULTIMO branch in ordine. " +
      'Sourcing dei branch: lista CSV esplicita di nodeId via "sourceNodeIds" (raccomandato per multi-branch ' +
      'complessi); se vuoto prende TUTTI i nodeOutputs disponibili al merge. I branch senza output (es. ramo ' +
      'skipato da logic_switch) vengono semplicemente esclusi. Chiavi nodeId tipo `__proto__` non inquinano il ' +
      'prototype (Object.create(null)). ' +
      'Use case ricchi della pipeline business: 3 web search paralleli (Google + Bing + DuckDuckGo) → 60 ' +
      'risultati uniti per dedup downstream + lead scoring; multi-API enrichment di un lead B2B (lookup CRM ' +
      'Odoo + social media LinkedIn + geo location da IP) in parallelo → object enriched complete per il ' +
      'sales team; ensemble AI agent voting su task di classificazione difficile (3 LLM provider diversi ' +
      'votano la stessa label, majority vote dello strategia "all" con post-processing); aggregazione status ' +
      'monitoring (uptime check su 5 endpoint concurrent) in unica dashboard view; fan-out su multi-channel ' +
      'notification (Slack + Telegram + Email + WhatsApp) con merge per audit di delivery status complessivo.',
    configFields: [
      {
        key: 'strategy',
        label: 'Strategia di merge',
        type: 'select',
        required: true,
        options: ['all', 'concat-arrays', 'any', 'first', 'last'],
        defaultValue: 'all',
        help: "• all (default): output = { branches: {nodeId: output, ...} }\n• concat-arrays: estrae output.<arrayProperty>[] di ogni branch + concatena in 1 array unico (use case 3 search → 60 result)\n• any/first: prende il primo branch (idx più basso)\n• last: prende l'ultimo",
      },
      {
        key: 'sourceNodeIds',
        label: 'Source node IDs (CSV, opzionale)',
        type: 'text',
        required: false,
        placeholder: 'search_yacht_it,search_distrib_eu,search_marina_med',
        help: 'CSV degli id dei nodi sorgente da combinare. Se vuoto, prende TUTTI i nodi precedentemente eseguiti (auto-discovery, OK per workflow lineari semplici). Riempire ESPLICITAMENTE per workflow con multi-branch complessi.',
      },
      {
        key: 'arrayProperty',
        label: 'Property name (solo per strategy=concat-arrays)',
        type: 'text',
        required: false,
        defaultValue: 'results',
        placeholder: 'results',
        help: 'Nome del campo che contiene l\'array da concatenare. Default "results" (matcha action_web_search.results). Cambialo se i tuoi nodi sorgente usano altro nome (es. "items", "rows").',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

export const delayNode: NodeModule = {
  def: {
    id: 'logic_delay',
    type: 'logic',
    label: 'Delay',
    // "aspetta 5 minuti" / "sleep": l'attesa in linguaggio naturale.
    searchAliases: ['wait', 'sleep', 'pausa', 'attesa', 'minuti', 'secondi'],
    icon: 'pause',
    color: '#f59e0b',
    description:
      "Operatore di pausa BREVE in-process — sospende l'esecuzione del workflow per una durata configurabile " +
      'in millisecondi (cap di sicurezza 60s: una pausa in-process tiene occupato il worker, quindi è ' +
      'volutamente breve). È pensato per micro-pause: pacing tra chiamate, piccoli debounce, attese di ' +
      'propagazione. ⚠️ Per attese LUNGHE o che devono sopravvivere a un restart del container usa logic_wait ' +
      '(modo timer, fino a 24h) o logic_wait_signal (resumable, persistito in paused_workflows): quelli NON ' +
      'bloccano un worker e riprendono dopo crash/deploy. ' +
      "Use case: rate-limit manuale tra chiamate API esterne quando l'upstream NON espone header Retry-After " +
      'standard (es. legacy SOAP web service con cap 5 req/min hardcoded — delay 12s tra chiamate consecutive); ' +
      'wait deterministico per propagazione DNS dopo create record (es. 30s per A record DNS reload via ' +
      'Cloudflare) o propagazione cache CDN dopo invalidation; pacing su workflow batch outbound (es. spedire ' +
      '1 email al secondo per stare sotto le soglie reputation Gmail/SES); debounce su rapid trigger consecutivi ' +
      '(es. webhook che parte 3 volte in 2s da retry upstream — il primo workflow fa delay 5s e POI verifica ' +
      'se è il più recente run aggiornato, altrimenti skip — pattern "wait for quiet"); pause intenzionale prima ' +
      "di azione costosa per dare tempo all'operatore umano di intervenire (es. delay 60s prima di cancellare " +
      '500 record da database con notify Telegram per cancel manuale se errore).',
    configFields: [
      {
        key: 'durationMs',
        label: 'Durata (ms)',
        type: 'number',
        required: true,
        defaultValue: '1000',
        help: 'Millisecondi di pausa. Cap di sicurezza 60000 (60s): oltre, la durata viene clampata — per attese più lunghe usa logic_wait o logic_wait_signal.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};

// `errorHandlerNode` (defId `logic_error_handler`) eliminato 2026-06-06:
// dichiarato come NodeDef + suggerito da prompt AI scaffold, ma MAI implementato
// runtime → ogni workflow che lo usava crashava con "Unknown node def" al run.
// Pattern fail-soft attuale: avvolgere chiamate rischiose in subworkflow +
// branch on output dell'error path emesso dal nodo stesso (HTTP, LLM, ecc.
// emettono `error` come campo dell'output, non come exception). Decisione
// post-audit ghost-coverage 2026-06-06 — vedi engine/ghost-coverage.test.ts.
