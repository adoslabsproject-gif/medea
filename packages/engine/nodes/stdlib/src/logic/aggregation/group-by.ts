/**
 * GroupByNode — raggruppa un array per il valore di un campo.
 *
 * Output: `{ groups: { <valore>: [item...] }, groupCount, totalItems }`.
 * Item con campo missing/null finiscono nel bucket `__missing__` (preservazione,
 * mai discard silenzioso — l'operatore vede esattamente quanti orphan ci sono).
 */

import type { NodeModule, NodeExecutor } from '../../types.js';
import { getField, capItems, groupKeyString } from './helpers.js';

const executor: NodeExecutor = async (config, input) => {
  const startedAt = Date.now();
  const { items, warning } = capItems(input, config.maxItems);
  const key = String(config.groupKey ?? '');
  const floatPrecision = Math.max(0, Math.min(Number(config.floatPrecision ?? 4), 12));
  // `Object.create(null)`: la group-key è attacker-controlled. Con `{}`, una chiave
  // `__proto__` leggerebbe l'accessor del prototype → `??=` non assegna → `.push` su
  // Object.prototype → TypeError (crash deterministico pilotabile). Null-proto = chiave
  // come proprietà OWN normale (Object.keys/entries enumerano solo le own → invariato).
  const groups = Object.create(null) as Record<string, unknown[]>;
  for (const item of items) {
    const k = groupKeyString(getField(item, key), floatPrecision);
    (groups[k] ??= []).push(item);
  }
  // counts per gruppo + gruppo più grande/piccolo (per report e branch decision).
  const counts = Object.create(null) as Record<string, number>;
  let largestGroup: string | null = null;
  let smallestGroup: string | null = null;
  for (const [k, v] of Object.entries(groups)) {
    counts[k] = v.length;
    if (largestGroup === null || v.length > groups[largestGroup]!.length) largestGroup = k;
    if (smallestGroup === null || v.length < groups[smallestGroup]!.length) smallestGroup = k;
  }
  return {
    output: {
      groups,
      counts,
      groupCount: Object.keys(groups).length,
      totalItems: items.length,
      largestGroup,
      smallestGroup,
    },
    durationMs: Date.now() - startedAt,
    ...(warning ? { warnings: [warning] } : {}),
  };
};

export const groupByNode: NodeModule = {
  def: {
    id: 'logic_group_by',
    type: 'logic',
    label: 'Group By',
    // "raggruppa per categoria" — copre anche la canonizzazione raggruppa→group.
    searchAliases: ['raggruppa', 'categoria', 'aggregate'],
    icon: 'layers',
    color: '#f59e0b',
    description:
      'Operatore di raggruppamento enterprise stile SQL GROUP BY ma applicato in-memory a un array di oggetti ' +
      'JavaScript proveniente da uno step upstream del workflow — fondamento di tutte le pipeline di analytics, ' +
      'reporting, batch processing che lavorano su dataset rappresentati come array di records (output di ' +
      'action_db_query, action_csv_parse, listCommits, queryDatabase Notion, ecc.). Accetta un\'espressione di ' +
      'path/key per identificare il campo di raggruppamento — supporto nativo per path nested con notazione ' +
      'dot/bracket: "user.country" (group per country del nested user), "customer.address[0].city" (primo ' +
      'indirizzo del cliente), con precedenza al match esatto se una chiave contiene letteralmente un punto. ' +
      'Handling robusto dei valori mancanti: null e undefined finiscono nel gruppo speciale "__missing__" ' +
      'invece di essere silenziosamente droppati (evita il bug subdolo dei dataset che sembrano completi ma ' +
      'hanno record orfani non contati); empty string "" resta un gruppo separato da null; per le chiavi ' +
      'numeriche con decimali la rappresentazione è fissata a "floatPrecision" decimali (default 4) così 0.1+0.2 ' +
      'e 0.3 cadono nello stesso bucket. ' +
      'Output: { groups: { [chiave]: [item...] }, counts: { [chiave]: N }, groupCount, totalItems, ' +
      'largestGroup (chiave del gruppo più numeroso), smallestGroup }. ' +
      'Use case classici della pipeline business: raggruppare 200 ordini in pipeline per cliente prima di ' +
      'emettere fatture mensili consolidate via action_pdf_generate (1 fattura per cliente invece di 200 ' +
      'singole); aggregare 100k righe di audit_log per ora/giorno per popolare dashboard analytics tenant; ' +
      'raggruppare 5000 lead CRM per source ("google_ads", "linkedin_organic", "referral_partner") per il ' +
      'report ROI per source del marketing manager; raggruppare email triage per categoria per generare ' +
      'metriche di customer support per il monthly business review; pre-processing prima di logic_aggregate ' +
      '(group + sum/avg/min/max/count) — la coppia group_by → aggregate è il workhorse delle pipeline ETL ' +
      'leggere senza dover scendere a SQL diretto.',
    configFields: [
      {
        key: 'sourceExpression',
        label: 'Array da raggruppare',
        type: 'expression',
        required: true,
        defaultValue: 'input',
        placeholder: 'input.records',
        help: 'Espressione JS che ritorna un array. Default = input. Es. input.orders.',
      },
      {
        key: 'groupKey',
        label: 'Campo per raggruppare',
        type: 'text',
        required: true,
        placeholder: 'es. customer_id, category, region',
        help: 'Nome del campo dell\'item su cui raggruppare (supporta dot-path: user.country, items[0].city). Es. items=[{customer:1},{customer:2},{customer:1}] con groupKey=customer → { "1": [...], "2": [...] }.',
      },
      {
        key: 'floatPrecision',
        label: 'Decimali per chiavi numeriche',
        type: 'number',
        required: false,
        defaultValue: '4',
        help: 'Numero di decimali a cui fissare le chiavi numeriche con virgola (così 0.1+0.2 e 0.3 finiscono nello stesso gruppo). Default 4, max 12. Gli interi non sono toccati.',
      },
      {
        key: 'maxItems',
        label: 'Max item (cap difensivo)',
        type: 'number',
        required: false,
        defaultValue: '100000',
        help: 'Hard cap anti-OOM sul numero di item processati. Se l\'input supera questa soglia viene troncato e raggruppa solo i primi N (warning emesso). Default 100k, tetto 1M.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor,
};
