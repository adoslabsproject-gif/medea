/**
 * DistinctNode — rimuove duplicati da un array.
 *
 * Comparazione: JSON.stringify dell'intero item (default) o di un campo specifico.
 * Stable: preserva l'ordine, mantiene il PRIMO match (semantica Lodash uniqBy).
 * Output: `{ items, original, distinct, removed }` per observability.
 */

import type { NodeModule, NodeExecutor } from '../../types.js';
import { getField, capItems, stableStringify } from './helpers.js';

const executor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const { items, warning } = capItems(input, config.maxItems);
  // `field` accetta UN campo o PIÙ campi separati da virgola (dedup composta:
  // "vat,country"). Vuoto = confronta l'intero item.
  const fields = String(config.field ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  const normalize = config.normalize === true || config.normalize === 'true';

  // Chiave CANONICA (stableStringify ordina le chiavi → `{a,b}`=={b,a}). Con `normalize`
  // i valori-stringa dei campi sono trim+lowercase (dedup "Mario@X" == "mario@x ").
  const keyOf = (item: unknown): string => {
    if (fields.length === 0) return stableStringify(item);
    return fields.map((f) => {
      const v = getField(item, f);
      return stableStringify(normalize && typeof v === 'string' ? v.trim().toLowerCase() : v);
    }).join('');
  };

  const seen = new Set<string>();
  const out: unknown[] = [];
  const exampleDuplicates: unknown[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      if (exampleDuplicates.length < 5) exampleDuplicates.push(item);
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  const removed = items.length - out.length;
  return {
    output: {
      items: out,
      original: items.length,
      distinct: out.length,
      removed,
      removalPercent: items.length > 0 ? Number((removed / items.length * 100).toFixed(2)) : 0,
      exampleDuplicates,
    },
    durationMs: Date.now() - startedAt,
    ...(warning ? { warnings: [warning] } : {}),
  };
};

export const distinctNode: NodeModule = {
  def: {
    id: 'logic_distinct',
    type: 'logic',
    label: 'Distinct',
    // "rimuovi i duplicati" / n8n "Remove Duplicates".
    searchAliases: ['duplicati', 'dedup', 'unique', 'duplicates'],
    icon: 'filter',
    color: '#f59e0b',
    description:
      'Operatore di deduplicazione enterprise che rimuove voci duplicate da un array di oggetti — la primitiva ' +
      'fondamentale di tutte le pipeline ETL e analytics dove si aggregano dati da fonti multiple (webhook ' +
      'retry, scraping multi-pagina, merge CRM+marketing+social, ingest legacy CSV) e ci si trova ' +
      'inevitabilmente con record fantasma duplicati che inquinano analytics, popolano email a stesso cliente ' +
      'più volte, generano notifiche multiple del stesso evento, gonfiano i counter di KPI. ' +
      'Due modalità complementari per coprire tutti i pattern di equality semantic: ' +
      '(1) Mode senza key (deep equality structural) — compara l\'intero oggetto serializzato come JSON ' +
      'canonical-form (ordering deterministico dei field per evitare false positive su { name: "A", city: "X" } ' +
      'vs { city: "X", name: "A" } che son lo stesso oggetto), match esatto bit-perfect tra item considerati ' +
      'duplicati, drop dei subsequent occurrences preservando il PRIMO inserito (preserve order originale array ' +
      'che è semantica naturale per LRU-like behavior); ' +
      '(2) Mode con key field — l\'utente specifica uno o più campi (es. ["email"], oppure ["vat", "country"] ' +
      'per dedup composta), item con stesso valore (concatenato per multi-key) restano solo il primo, gli altri ' +
      'vengono droppati anche se diversi in altri campi (use case: dedup per email_address di un merge di N ' +
      'sorgenti CRM dove la stessa persona compare con nomi formattati diversamente — "Mario Rossi" vs "M. ' +
      'Rossi" vs "MARIO ROSSI" tutti via email mario@acme.com → tieni solo il primo, scarta gli altri 2). ' +
      'Performance: l\'algoritmo usa un Set per lookup O(N) invece di O(N²) naïve double-loop — gestisce ' +
      'array di 100k+ item senza saturare la CPU. La normalizzazione opzionale (flag "normalize") applica ' +
      'trim+lowercase ai valori-stringa dei campi prima del confronto (dedup "Mario@X" == "mario@x ").\n\n' +
      'Output: { items (array dedupped, ordine originale preservato, primo match tenuto), original, distinct, ' +
      'removed, removalPercent, exampleDuplicates (fino a 5 esempi di duplicati rimossi per debug/audit) }. ' +
      'Use case operativi: dedup lista email/contatti dopo merge di N sorgenti CRM (Pipedrive imported + ' +
      'Mailchimp + Odoo res.partner) prima di un mass-mailing per evitare di spedire 3× allo stesso indirizzo ' +
      '(GDPR fastidio + reputation IP); unique URL da scraping multi-pagina/multi-spider perché lo stesso ' +
      'URL può comparire come link in 10 pagine diverse del sito ma vogliamo crawlarlo solo 1×; rimuovere ' +
      'ordini duplicati ricevuti via webhook retry (Stripe/PayPal con at-least-once delivery garantita riprovano ' +
      'webhook fino a 3-7 volte in caso di timeout — gestione idempotency); normalize result list pre-loop per ' +
      'evitare lavorazione doppia di stesso item in logic_loop body (es. per fiscal_code dei clienti ricevuti ' +
      'da PEC, per messageId Slack già processati, per event_id audit_log per ingest analytics warehouse).',
    configFields: [
      {
        key: 'sourceExpression',
        label: 'Array da deduplicare',
        type: 'expression',
        required: true,
        defaultValue: 'input',
        help: 'Espressione JS che ritorna un array. Default = input.',
      },
      {
        key: 'field',
        label: 'Campo/i per il confronto (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'es. email  oppure  vat,country',
        help: 'Uno o più campi separati da virgola (dedup composta, es. "vat,country"). Supporta dot-path (user.email). Se vuoto, confronta l\'intero item (equivalenza strutturale canonica).',
      },
      {
        key: 'normalize',
        label: 'Normalizza (trim + minuscolo)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Se ON: i valori-stringa dei campi sono trim+lowercase prima del confronto (es. dedup email case-insensitive). Applicato solo in modalità con campo/i.',
      },
      {
        key: 'maxItems',
        label: 'Max item (cap difensivo)',
        type: 'number',
        required: false,
        defaultValue: '100000',
        help: 'Hard cap anti-OOM sul numero di item processati. Se l\'input supera questa soglia viene troncato e deduplica solo i primi N (warning emesso). Default 100k, tetto 1M.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor,
};
