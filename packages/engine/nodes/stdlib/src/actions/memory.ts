/**
 * `memory_note` — persistent key-value memory scoped per (workspace, workflow, key).
 *
 * Use case
 * ────────
 * Workflow che hanno bisogno di "ricordare" state cross-run:
 *  - contatore tentativi prima di skip
 *  - ultimo cursor pagination DB esterno (per polling)
 *  - cache costo API (es. "Liara generato gia\` X tokens questo mese")
 *  - flag "ho gia\` notificato l'utente per questo evento"
 *  - timestamp ultima esecuzione (per cron skip-if-too-recent)
 *
 * Operations
 * ──────────
 *   get      — leggi valore (output.value, output.exists)
 *   set      — scrivi/sovrascrivi (overwrite)
 *   append   — append a stringa esistente (con separator opzionale)
 *   delete   — rimuovi key
 *   list     — lista tutte le key di questo workflow (output.keys)
 *
 * Storage
 * ───────
 * Tabella SQLite per-tenant `workflow_memory`:
 *   workflow_id TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(workflow_id, key)
 * Schema creato lazy alla prima chiamata.
 *
 * @module actions/memory
 */

import type { NodeModule } from '../types.js';

export const memoryNoteNode: NodeModule = {
  def: {
    id: 'memory_note',
    type: 'action',
    label: 'Memory: persistent KV store',
    icon: 'database',
    color: '#8b5cf6',
    description:
      'Storage enterprise chiave-valore persistente scoped per workflow — la primitiva per implementare ' +
      'workflow stateful che devono ricordare dati cross-run tra esecuzioni successive del stesso workflow ' +
      '(cursor di paginazione di sync incrementali, contatori di retry, flag di "già processato" per ' +
      'idempotency, baseline KPI per detection di drift, timestamp di "ultima esecuzione" per cron skip-if-recent ' +
      'logic). Implementazione robusta su SQLite per-tenant del runtime, table dedicata `workflow_memory` con ' +
      'isolation rigorosa per workflow_id — workflow diversi NON si vedono tra loro (gli engineer principle di ' +
      'least privilege + memoria privata per workflow per evitare leak di state tra contesti separati e ' +
      'comportamenti emergenti debugging-difficili). ' +
      'Cinque operazioni atomiche coprono tutti i pattern stateful necessari: ' +
      '(1) get — legge il valore associato a una key; se la key non esiste ritorna value=null ed exists=false ' +
      '(pattern safe check-before-use), oppure il valore di default se configurato (usedDefault=true); ' +
      '(2) set — scrive (o sovrascrive se esiste) il valore della key, valore può essere qualsiasi JSON ' +
      'serializzabile (string, number, boolean, array, object nested fino a 1MB cap per safety); ' +
      '(3) append — concatena il valore a una stringa esistente con un separator configurabile (default ' +
      'newline), crea la key se non esiste (pattern naturale per log accumulato di righe); ' +
      '(4) delete — rimuove la key (idempotent: delete su key inesistente = no-op); ' +
      '(5) list — restituisce l\'elenco delle key esistenti per il workflow corrente, con filtro pattern glob ' +
      'opzionale (es. "cursor:*" → tutte le key che iniziano con "cursor:"; * = molti char, ? = un char) ' +
      '(output keys[] + count + pattern). ' +
      'TTL opzionale per auto-cleanup: ogni key può avere un TTL in secondi; la pulizia è LAZY al prossimo get ' +
      '(una key scaduta viene cancellata e ritorna exists=false) — pattern utile per cache time-limited (es. ' +
      '"deduplica notify per 24h" → key con TTL 86400s) senza dover gestire manualmente la cleanup logic. ' +
      'Concurrency: le operazioni sono atomic (SQLite transaction per write), in caso di concurrent run dello ' +
      'stesso workflow (es. due trigger_webhook simultanei), le scritture sono serialized — no race condition ' +
      'su counter increment (l\'idiom get → modify → set è race-prone, raccomandato pattern dedicated atomic ' +
      'increment se servisse). ' +
      'Output: { value, exists, updatedAt, expiresAt (timestamp scadenza o null), operation, usedDefault (get), ' +
      'oldValue e changed (set, per audit del cambio), keys[] + count + pattern (list) }. ' +
      'Use case: memorizzare cursor di paginazione di una sync incrementale (es. "last_synced_at" per next ' +
      'iteration del cron, evita ri-fetch dei dati già processati); contatore tentativi retry distribuito su ' +
      'run cron schedulati (retry_count++ ogni fail, reset al success); flag "già notificato" per evitare ' +
      'doppi alert su stesso evento ricorrente (key "alerted:incident:XYZ" con TTL 24h); timestamp ultima ' +
      'esecuzione per cron skip-if-recent logic (se < 5min fa, skip questo tick); budget spese API mensili ' +
      '(cumulative cost tracking per quota enforcement custom oltre quelle del piano); accumulo di list di ' +
      'errori per batch summary email digest a fine giornata.',
    configFields: [
      {
        key: 'operation',
        label: 'Operazione',
        type: 'select',
        required: true,
        defaultValue: 'get',
        options: ['get', 'set', 'append', 'delete', 'list'],
        help: 'get = leggi valore. set = scrivi/sovrascrivi. append = aggiungi a stringa. ' +
          'delete = rimuovi. list = lista tutte le key di questo workflow.',
      },
      {
        key: 'key',
        label: 'Chiave',
        type: 'expression',
        required: false,
        placeholder: 'last_pagination_cursor',
        help: 'Identifier univoco per workflow (snake_case raccomandato). ' +
          'Required per get/set/append/delete. Ignorato per list.',
      },
      {
        key: 'value',
        label: 'Valore (per set/append)',
        type: 'expression',
        required: false,
        placeholder: '{{$node.lastPage.json.cursor}}',
        help: 'Valore da scrivere. Object → serializzato JSON. Required per set/append. ' +
          'Per append: viene aggiunto in coda al valore esistente (con separator se configurato).',
      },
      {
        key: 'default',
        label: 'Valore di default (solo get)',
        type: 'expression',
        required: false,
        placeholder: 'es. 0  oppure  {{input.fallback}}',
        help: 'Se la key NON esiste, get ritorna questo valore (exists resta false, usedDefault=true). ' +
          'Vuoto = ritorna null.',
        showIf: { field: 'operation', equals: 'get' },
      },
      {
        key: 'pattern',
        label: 'Filtro pattern (solo list)',
        type: 'text',
        required: false,
        placeholder: 'es. cursor:*',
        help: 'Glob opzionale per filtrare le key: * = molti caratteri, ? = un carattere. ' +
          'Es. "cursor:*" elenca solo le key che iniziano con "cursor:". Vuoto = tutte le key.',
        showIf: { field: 'operation', equals: 'list' },
      },
      {
        key: 'appendSeparator',
        label: 'Separator (solo append)',
        type: 'text',
        required: false,
        defaultValue: '\\n',
        help: 'Default "\\n" (newline). Usato SOLO se operation=append e key esiste gia\\`. ' +
          'Es. "," → "a,b,c". Empty → concat puro.',
      },
      {
        key: 'ttlSeconds',
        label: 'TTL secondi (auto-delete)',
        type: 'number',
        required: false,
        placeholder: '86400',
        help: 'Opzionale. Quando settato, la key scade dopo N secondi dall\'ultimo write. ' +
          'Cleanup avviene lazy al prossimo read (key scaduta → output.exists=false, row deleted).',
      },
    ],
    outputs: ['value', 'exists', 'updatedAt', 'expiresAt', 'usedDefault', 'oldValue', 'changed', 'keys', 'count', 'pattern', 'operation'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: { typicalLatencyMs: 5 },
  },
};
