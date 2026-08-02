/**
 * Auto-fix Layer C — sostituzioni triviali PRE quality gate.
 *
 * Pipeline order in singleshot:
 *   1. Layer A (context injection) → pre-LLM
 *   2. LLM dispatch + parse
 *   3. **Layer C (auto-fix triviali) ← QUI**
 *   4. Quality gate
 *   5. Layer B (retry se reject) ← già implementato
 *
 * Filosofia: NON aggressive. Solo sostituzioni 100% safe:
 *  - Pattern placeholder noti → `{{secrets.NOME_DESCRITTIVO}}` (l'utente
 *    configura una volta, mai chiede di nuovo)
 *  - Duplicate nodes con stessa config → mantieni il PRIMO, rimuovi gli
 *    altri, ri-route gli edges al primo
 *  - ID risorsa fittizi → `__USE_PICKER__` marker (UI mostra dropdown
 *    forzato pre-import)
 *
 * Output: nuovo workflow + lista `appliedFixes` per logging/notifica.
 */

import { detectCodeLanguage, CODE_NODE_FOR_LANG, LANG_FOR_CODE_NODE } from './code-lang.js';

/**
 * Pattern dell'ID di un nodo merge/join. Un edge verso/da un id che matcha QUESTO
 * pattern ma il cui nodo MANCA è un merge non emesso dall'LLM → l'orphan-heal lo
 * CREA come logic_merge (non lo scarta). Esportato come single-source-of-truth:
 * la validazione pre-auto-fix in singleshot.service lo usa per NON 502are su un
 * orphan che l'auto-fix sanerà subito dopo.
 */
export const MERGE_ORPHAN_ID_RE = /(^|[_-])(merge|join)([_-]|$)/i;

export interface AutoFixInput {
  nodes: { id: string; defId: string; config: Record<string, unknown>; [k: string]: unknown }[];
  edges: { from: string; to: string; [k: string]: unknown }[];
  /**
   * The LLM provider name the tenant has chosen as default in Settings.
   * When present, any `agent_*` node with a different `config.provider` gets
   * normalized to this one (and the dangling `apiKey`/`model` fields are
   * cleared, see fix type `agent_provider_normalized`). Pass `null` to skip.
   */
  tenantDefaultLlmProvider?: string | null;
}

export interface AutoFixResult {
  nodes: AutoFixInput['nodes'];
  edges: AutoFixInput['edges'];
  appliedFixes: {
    type:
      | 'placeholder_to_secret'
      | 'merge_duplicate_nodes'
      | 'id_to_picker_marker'
      | 'force_loop_strategy_batch'
      | 'agent_provider_normalized'
      | 'obsolete_model_cleared'
      | 'fan_in_merge_inserted'
      | 'orphan_edge_healed'
      | 'code_node_lang_corrected';
    nodeId?: string;
    field?: string;
    before?: string;
    after?: string;
    detail?: string;
  }[];
}

/**
 * Models the vendor has deprecated. Auto-fix clears the field — the runtime
 * dispatcher will fall back to the provider's current default model.
 * Keep in sync with `OBSOLETE_MODELS_BY_PROVIDER` in `quality-gate.ts`.
 */
const OBSOLETE_MODELS_BY_PROVIDER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'openai',
    new Set([
      'gpt-3.5-turbo-0301',
      'gpt-3.5-turbo-0613',
      'gpt-3.5-turbo-16k-0613',
      'gpt-4-0314',
      'gpt-4-0613',
      'gpt-4-32k-0314',
      'gpt-4-32k-0613',
      'text-davinci-003',
      'text-davinci-002',
      'code-davinci-002',
    ]),
  ],
  [
    'anthropic',
    new Set([
      'claude-instant-1',
      'claude-instant-1.2',
      'claude-1',
      'claude-1.3',
      'claude-2',
      'claude-2.0',
      'claude-2.1',
      'claude-3-haiku-20240307',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
    ]),
  ],
  ['gemini', new Set(['gemini-pro', 'gemini-pro-vision', 'gemini-1.0-pro'])],
  ['mistral', new Set(['mistral-tiny', 'mistral-small', 'mistral-medium'])],
]);

// Pattern di sostituzione: regex → secret name. Conservativi (solo casi
// alta confidence). Ordine importante (specifici prima di generici).
const PLACEHOLDER_TO_SECRET: { regex: RegExp; secret: string; fields?: RegExp }[] = [
  // Bucket S3/GCS (matcha SOLO scheme+name, path preservato automaticamente)
  {
    regex:
      /\bs3:\/\/(?:my-bucket|your-bucket|bucket-name|test-bucket|sample-bucket|demo-bucket|example-bucket|company-bucket|tenant-bucket|placeholder-bucket)\b/gi,
    secret: 'S3_BUCKET',
  },
  // SMTP host
  { regex: /\bsmtp\.example\.com\b/gi, secret: 'SMTP_HOST' },
  // Email noreply placeholder
  {
    regex: /\bnoreply@(?:company|yourcompany|mycompany|placeholder|example)\.[a-z]{2,}\b/gi,
    secret: 'NOREPLY_EMAIL',
  },
  // Email dst placeholder
  {
    regex:
      /\b(?:management|admin|support|info|sales)@(?:company|yourcompany|mycompany|placeholder)\.[a-z]{2,}\b/gi,
    secret: 'NOTIFY_EMAIL',
  },
  // URL endpoint placeholder
  {
    regex:
      /\bhttps?:\/\/(?:api|service|endpoint|server)\.(?:company|yourcompany|placeholder|example)\.[a-z]{2,}(?:\/[^"]*)?/gi,
    secret: 'API_URL',
  },
];

// Field name patterns che richiedono UN ID risorsa REALE (UUID/hash).
// Se valore non-template e non-UUID → sostituisci con __USE_PICKER__.
const PICKER_FIELDS_RE =
  /^(databaseId|tableId|workspaceId|projectId|accountId|systemAccountId|botId|channelId|spaceId|orgId|emailAccountId)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_ID_RE = /^[A-Za-z0-9_-]{16,}$/;
const TEMPLATE_RE = /\{\{|\$node\./;

/**
 * Tipi di configField risolvibili da un PICKER dinamico nella UI pre-import
 * (dropdown forzato su `__USE_PICKER__`). Allineati a ConfigFieldTypeSchema
 * di core-schema — solo i picker che la UI di import sa davvero renderizzare.
 */
const DYNAMIC_PICKER_FIELD_TYPES = new Set([
  'db-picker',
  'db-table-picker',
  'db-collection-picker',
  'workflow-picker',
  'email-account-picker',
]);

/**
 * True se un campo può essere risolto da un picker UI → un valore REQUIRED
 * *omesso* dall'LLM va sanato con `__USE_PICKER__`, NON rigettato.
 *
 * Bug diretta YouTube 2026-06-12: Liara generava db_insert SENZA `databaseId`
 * → la validazione required (che gira PRIMA del Layer C) 502ava l'intero
 * scaffold, mentre lo stesso campo con un valore FITTIZIO veniva sanato qui
 * sotto (sezione 2). Il caso "omesso" e il caso "fittizio" devono convergere
 * sullo stesso marker. Match per nome (PICKER_FIELDS_RE) O per tipo catalog.
 */
export function isPickerResolvableField(fieldKey: string, fieldType?: string): boolean {
  if (PICKER_FIELDS_RE.test(fieldKey)) return true;
  return fieldType !== undefined && DYNAMIC_PICKER_FIELD_TYPES.has(fieldType);
}

function looksLikeRealId(s: string): boolean {
  if (!s || typeof s !== 'string') return true; // skip non-string
  if (TEMPLATE_RE.test(s)) return true; // template syntax = lascia
  if (s === '__USE_PICKER__') return true; // idempotenza: marker già applicato
  if (UUID_RE.test(s)) return true;
  if (HASH_ID_RE.test(s)) {
    // Anche se hash-like, se contiene parole sospette dentro snake_case,
    // NON è real
    const SUSPECT =
      /(?:^|[_-])(name|placeholder|example|sample|here|todo|fixme|test|demo|fake|mock|your|my|company|new|generic|opportunities|account)(?:[_-]|$)/i;
    if (SUSPECT.test(s)) return false;
    // Lazy prefix tipo "db_X" "acc_X" senza alfanumerico randomico
    const LAZY =
      /^(db|acc|tenant|workspace|project|user|email|smtp|imap|system|sys|table|tbl)[_-][a-z]+(?:[_-][a-z]+)?$/i;
    if (LAZY.test(s)) return false;
    return true;
  }
  return false;
}

/**
 * Applica auto-fix al workflow generato. Idempotente: girare 2x produce
 * stesso output.
 */
export function autoFixWorkflow(input: AutoFixInput): AutoFixResult {
  const result: AutoFixResult = {
    nodes: input.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: input.edges.map((e) => ({ ...e })),
    appliedFixes: [],
  };

  // 0. HEAL edge orfani — edge che referenzia un nodo INESISTENTE.
  //    Bug user-segnalato 2026-06-10: l'LLM genera un loop con N branch paralleli
  //    che si ricongiungono in un merge (es. edge `seo_audit → merge_logic_loop_1`)
  //    ma DIMENTICA di emettere il nodo merge → edge orfani → WorkflowService.update
  //    rifiuta (save 500). Heal: se l'id orfano è un merge/join (pattern `merge*`
  //    /`*merge*`/`join*`), CREA il `logic_merge` mancante (l'LLM voleva il join);
  //    altrimenti SCARTA l'edge (referenza irrecuperabile, meglio un grafo valido
  //    senza quell'arco che un save rotto).
  {
    const nodeIds = new Set(result.nodes.map((n) => n.id));
    const MERGE_ID_RE = MERGE_ORPHAN_ID_RE;
    const mergesToCreate = new Set<string>();
    const keptEdges: AutoFixResult['edges'] = [];
    for (const e of result.edges) {
      const orphans = [
        !nodeIds.has(e.from) ? e.from : null,
        !nodeIds.has(e.to) ? e.to : null,
      ].filter((x): x is string => x !== null);
      if (orphans.length === 0) {
        keptEdges.push(e);
        continue;
      }
      if (orphans.every((id) => MERGE_ID_RE.test(id))) {
        for (const id of orphans) mergesToCreate.add(id);
        keptEdges.push(e); // diventa valido dopo la creazione del merge
      } else {
        result.appliedFixes.push({
          type: 'orphan_edge_healed',
          detail: `Edge orfano scartato: "${e.from}" → "${e.to}" (nodo inesistente non recuperabile).`,
        });
        // edge droppato (non aggiunto a keptEdges)
      }
    }
    for (const id of mergesToCreate) {
      const refCount = keptEdges.filter((e) => e.to === id || e.from === id).length;
      result.nodes.push({
        id,
        defId: 'logic_merge',
        config: {
          strategy: 'concat',
          __auto_inserted_reason:
            'Nodo merge referenziato dagli edge ma non emesso dall’LLM — ricreato dall’auto-fix.',
        },
      });
      nodeIds.add(id);
      result.appliedFixes.push({
        type: 'orphan_edge_healed',
        nodeId: id,
        detail: `Creato logic_merge "${id}" mancante (referenziato da ${String(refCount)} edge orfani).`,
      });
    }
    result.edges = keptEdges;
  }

  // 1. Pattern placeholder → {{secrets.X}}
  for (const node of result.nodes) {
    for (const [field, val] of Object.entries(node.config)) {
      if (typeof val !== 'string' || val.length === 0) continue;
      let mutated = val;
      for (const { regex, secret } of PLACEHOLDER_TO_SECRET) {
        const replacement = `{{secrets.${secret}}}`;
        if (regex.test(mutated)) {
          const before = mutated;
          mutated = mutated.replace(regex, replacement);
          if (before !== mutated) {
            result.appliedFixes.push({
              type: 'placeholder_to_secret',
              nodeId: node.id,
              field,
              before: before.slice(0, 100),
              after: mutated.slice(0, 100),
            });
          }
        }
      }
      if (mutated !== val) {
        node.config[field] = mutated;
      }
    }
  }

  // 2. ID risorsa fittizi → __USE_PICKER__
  for (const node of result.nodes) {
    for (const [field, val] of Object.entries(node.config)) {
      if (typeof val !== 'string' || val.length === 0) continue;
      if (!PICKER_FIELDS_RE.test(field)) continue;
      if (looksLikeRealId(val)) continue;
      const before = val;
      node.config[field] = '__USE_PICKER__';
      result.appliedFixes.push({
        type: 'id_to_picker_marker',
        nodeId: node.id,
        field,
        before: before.slice(0, 60),
        after: '__USE_PICKER__',
        detail: `Campo "${field}" non era un ID reale — la UI mostrera\` un dropdown forzato.`,
      });
    }
  }

  // 2.5 Force logic_loop strategy='batch' quando un downstream è aggregator.
  //     Bug user-segnalato 2026-05-31: il quality-gate rifiutava workflow con
  //     pattern "loop → ... → agent_data_analyst (report) → send_email"
  //     perché a runtime esegue N volte (1 per iteration) → costoso + spam.
  //     Fix automatico: imposta strategy=batch → loop esegue 1 volta sull'array
  //     aggregato e i downstream lavorano sul totale.
  const AGGR_KW =
    /(report|riepilogo|riassunto|summary|aggregat|totale|consolidat|sintesi|recap|digest)/i;
  const downstreamCache = new Map<string, Set<string>>();
  const downstreamOf = (startId: string): Set<string> => {
    const cached = downstreamCache.get(startId);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [startId];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      for (const e of result.edges) {
        if (e.from === cur && !out.has(e.to)) {
          out.add(e.to);
          stack.push(e.to);
        }
      }
    }
    downstreamCache.set(startId, out);
    return out;
  };
  for (const loop of result.nodes.filter((n) => n.defId === 'logic_loop')) {
    const cfg = loop.config;
    const currentStrategy = typeof cfg.strategy === 'string' ? cfg.strategy : 'naive';
    if (currentStrategy === 'batch') continue;
    const ds = downstreamOf(loop.id);
    let aggrFound = '';
    for (const dsId of ds) {
      const dsNode = result.nodes.find((n) => n.id === dsId);
      if (!dsNode) continue;
      const isAggr =
        dsNode.defId === 'agent_data_analyst' ||
        dsNode.defId === 'agent_summarizer' ||
        dsNode.defId === 'action_send_email';
      if (!isAggr) continue;
      if (AGGR_KW.test(JSON.stringify(dsNode.config))) {
        aggrFound = dsId;
        break;
      }
    }
    if (aggrFound) {
      loop.config.strategy = 'batch';
      result.appliedFixes.push({
        type: 'force_loop_strategy_batch',
        nodeId: loop.id,
        field: 'strategy',
        before: currentStrategy,
        after: 'batch',
        detail: `Loop "${loop.id}" aveva strategy="${currentStrategy}" con downstream aggregator "${aggrFound}". Forzato a "batch": il loop esegue 1 volta sull'array aggregato e l'aggregator lavora sul totale (era N esecuzioni → costoso + spam).`,
      });
    }
  }

  // 2.6 Code-node language auto-heal (2026-06-09 user-segnalato).
  //     Liara genera un nodo `action_run_js` ma vi incolla codice PYTHON
  //     (`import json, os` / `json.loads` / `print(...)`) + params python-only
  //     (`parseStdoutJson`/`allowNetwork`). A runtime isolated-vm fallisce al
  //     parse (`import` non è JS valido) → nodo MAI eseguibile. Il codice e i
  //     params sono però GIÀ corretti per `action_run_python`: basta correggere
  //     il defId. Vale anche al contrario (codice JS in un nodo run_python).
  //
  //     Conservativo: agisce SOLO quando il detector trova segnali ESCLUSIVI
  //     dell'altro linguaggio (mai su frammenti ambigui validi in entrambi).
  //     Idempotente: una seconda passata trova lang==node → no-op.
  for (const node of result.nodes) {
    const expectedLang = LANG_FOR_CODE_NODE.get(node.defId);
    if (!expectedLang) continue; // non è un nodo code (run_js/run_python)
    const codeRaw = node.config.code;
    if (typeof codeRaw !== 'string' || codeRaw.trim().length === 0) continue;
    const detected = detectCodeLanguage(codeRaw);
    if (detected === 'ambiguous' || detected === expectedLang) continue;
    const before = node.defId;
    const after = CODE_NODE_FOR_LANG[detected];
    node.defId = after;
    result.appliedFixes.push({
      type: 'code_node_lang_corrected',
      nodeId: node.id,
      field: 'defId',
      before,
      after,
      detail:
        `Nodo "${node.id}" era "${before}" ma il campo \`code\` è ${detected === 'python' ? 'Python' : 'JavaScript'} ` +
        `(segnali esclusivi rilevati). Corretto il defId a "${after}". I due nodi code condividono \`code\`/\`timeoutMs\`, ` +
        `quindi i parametri restano validi; eventuali campi specifici dell'altro nodo vengono ignorati dall'executor.`,
    });
  }

  // 2.7 agent_* provider normalization — il singleshot guess'a regolarmente
  //     "openai gpt-4o" o "anthropic claude" basandosi sul training data anche
  //     quando il tenant non ha quella chiave + ha esplicitamente scelto un
  //     altro provider come default (es. liara) in Settings. Conseguenza:
  //     scaffold genera workflow non-runnable senza configurazione manuale.
  //
  //     Fix: se tenant ha un default provider e il nodo agent_* usa qualcosa
  //     di diverso, lo riporta al default + pulisce apiKey/model lasciati
  //     hard-coded. Idempotente: una seconda passata è no-op.
  if (input.tenantDefaultLlmProvider) {
    const def = input.tenantDefaultLlmProvider;
    for (const node of result.nodes) {
      if (!node.defId.startsWith('agent_')) continue;
      const cfg = node.config;
      const currentProvider = typeof cfg.provider === 'string' ? cfg.provider.trim() : '';
      if (currentProvider === def) continue;
      // Niente fix se l'utente ha esplicitamente lasciato il provider vuoto —
      // a runtime il dispatcher cade comunque sul default tenant.
      if (currentProvider === '') continue;
      const before = currentProvider;
      cfg.provider = def;
      // Clean up the fields that referenced the previous provider's auth.
      // The runtime resolves `apiKey` from the tenant vault when omitted, so
      // a hard-coded `{{secrets.OPENAI_API_KEY}}` left behind would mask the
      // tenant's real key. Same for `model` — let the provider pick its
      // default model.
      if (typeof cfg.apiKey === 'string') {
        const apiKey = cfg.apiKey;
        if (apiKey.includes('{{secrets.') || apiKey === '') {
          delete cfg.apiKey;
        }
      }
      if (typeof cfg.model === 'string') {
        const model = cfg.model;
        // Clear well-known model ids of the WRONG provider so the new
        // provider's default takes over. Models cross-provider (es. tenant
        // di Anthropic con gpt-4o → cleaner switch to claude default).
        const KNOWN_MODEL_RE = /^(gpt-|o\d|claude-|gemini-|mistral-|llama-|deepseek-|qwen-|nha-)/iu;
        if (KNOWN_MODEL_RE.test(model)) {
          delete cfg.model;
        }
      }
      result.appliedFixes.push({
        type: 'agent_provider_normalized',
        nodeId: node.id,
        field: 'provider',
        before,
        after: def,
        detail: `Nodo "${node.id}" usava provider="${before}" ma il tenant ha scelto "${def}" come default in Settings → AI. Provider sostituito + cleared apiKey/model hard-coded.`,
      });
    }
  }

  // 2.8 Obsolete model auto-clear (2026-06-07 Cappella batch — Layer C #6).
  //     L'AI scaffold spesso suggerisce id di modelli che il vendor ha gia\`
  //     deprecato (es. gpt-3.5-turbo-0613, claude-3-haiku-20240307). Il
  //     dispatcher LLM ritorna 404/410 e l'utente vede un fail confuso a
  //     runtime. Auto-fix clearda il field — il dispatcher poi usa il
  //     defaultModel corrente del provider. Idempotente.
  for (const node of result.nodes) {
    if (!node.defId.startsWith('agent_')) continue;
    const provider =
      typeof node.config.provider === 'string' ? node.config.provider.toLowerCase() : '';
    const model = typeof node.config.model === 'string' ? node.config.model.trim() : '';
    if (!provider || !model) continue;
    const obsolete = OBSOLETE_MODELS_BY_PROVIDER.get(provider);
    if (!obsolete?.has(model)) continue;
    delete node.config.model;
    result.appliedFixes.push({
      type: 'obsolete_model_cleared',
      nodeId: node.id,
      field: 'model',
      before: model,
      after: '',
      detail: `Modello "${model}" è deprecato sul provider "${provider}". Field azzerato — il dispatcher userà il defaultModel corrente del provider.`,
    });
  }

  // 3. Merge duplicate nodes (stesso defId + stessa config, ignore "id")
  const hashMap = new Map<string, { keepId: string; dupIds: string[]; defId: string }>();
  for (const node of result.nodes) {
    const configHash = JSON.stringify(node.config, Object.keys(node.config).sort());
    const key = `${node.defId}|${configHash}`;
    const existing = hashMap.get(key);
    if (existing) {
      existing.dupIds.push(node.id);
    } else {
      hashMap.set(key, { keepId: node.id, dupIds: [], defId: node.defId });
    }
  }
  const dupsToRemove = new Set<string>();
  const idRewrite = new Map<string, string>(); // dupId → keepId
  for (const { keepId, dupIds, defId } of hashMap.values()) {
    if (dupIds.length === 0) continue;
    for (const did of dupIds) {
      dupsToRemove.add(did);
      idRewrite.set(did, keepId);
    }
    result.appliedFixes.push({
      type: 'merge_duplicate_nodes',
      nodeId: keepId,
      detail: `${(dupIds.length + 1).toString()} nodi "${defId}" con config IDENTICA mergiati a 1 (rimossi: ${dupIds.join(', ')}). Edges re-routati al nodo principale.`,
    });
  }
  if (dupsToRemove.size > 0) {
    // Rimuovi nodi duplicati
    result.nodes = result.nodes.filter((n) => !dupsToRemove.has(n.id));
    // Re-route edges: ogni from/to puntando a dup → keepId. Poi dedup edges.
    const edgeSet = new Set<string>();
    const newEdges: AutoFixInput['edges'] = [];
    for (const e of result.edges) {
      const from = idRewrite.get(e.from) ?? e.from;
      const to = idRewrite.get(e.to) ?? e.to;
      if (from === to) continue; // self-edge eliminato post-merge
      const key = `${from}->${to}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      newEdges.push({ ...e, from, to });
    }
    result.edges = newEdges;
  }

  // 6. FAN_IN_WITHOUT_MERGE auto-fix — quando N>1 edges convergono su un
  //    nodo non-aggregator (es. db_insert/action_email/action_http), inserisci
  //    un `flow_merge` PRIMA con strategy=concat. Il merge raccoglie i N
  //    payload in un array e il consumer riceve un singolo input deterministico.
  //
  //    Pre-fix: il quality gate respinge → utente vede error tecnico
  //    "[FAN_IN_WITHOUT_MERGE]". Post-fix: workflow accettato, l'utente non
  //    deve mai capire il pattern fan-in/merge.
  //
  //    Skip se il consumer è già un aggregator (data_analyst/summarizer/
  //    flow_merge/action_aggregate) o un branch picker (logic_if/switch/join).
  const AGGREGATOR_DEFIDS = new Set([
    'agent_data_analyst',
    'agent_summarizer',
    'action_aggregate',
    'flow_merge',
    'logic_merge',
    'logic_join',
  ]);
  const BRANCH_PICKERS = new Set(['logic_if', 'logic_switch']);
  const incomingByTarget = new Map<string, { from: string; edgeIdx: number }[]>();
  result.edges.forEach((e, idx) => {
    const arr = incomingByTarget.get(e.to) ?? [];
    arr.push({ from: e.from, edgeIdx: idx });
    incomingByTarget.set(e.to, arr);
  });
  const fanInTargets: string[] = [];
  for (const [target, sources] of incomingByTarget.entries()) {
    if (sources.length < 2) continue;
    const targetNode = result.nodes.find((n) => n.id === target);
    if (!targetNode) continue;
    if (AGGREGATOR_DEFIDS.has(targetNode.defId)) continue;
    if (BRANCH_PICKERS.has(targetNode.defId)) continue;
    fanInTargets.push(target);
  }
  if (fanInTargets.length > 0) {
    const usedIds = new Set(result.nodes.map((n) => n.id));
    const fixedEdges = [...result.edges];
    const newNodes = [...result.nodes];
    for (const target of fanInTargets) {
      // Genera ID merge node univoco (es. "merge_log_audit_12_1")
      let mergeId = `merge_${target}`;
      let suffix = 1;
      while (usedIds.has(mergeId)) {
        mergeId = `merge_${target}_${suffix.toString()}`;
        suffix++;
      }
      usedIds.add(mergeId);
      newNodes.push({
        id: mergeId,
        // FIX 2026-06-10: era 'flow_merge' — NON è un defId registrato (solo
        // 'logic_merge' lo è) → ogni fan-in produceva un nodo invalido. Corretto.
        defId: 'logic_merge',
        config: {
          strategy: 'concat',
          // Documentazione operatore: aiuta capire perché c'è il merge
          __auto_inserted_reason: `Auto-inserito da quality gate: ${target} aveva ${String((incomingByTarget.get(target) ?? []).length)} edge in entrata su un non-aggregator.`,
        },
      });
      // Re-route: tutte le edges che puntano a `target` ora puntano a `mergeId`
      for (let i = 0; i < fixedEdges.length; i++) {
        if (fixedEdges[i]?.to === target) {
          fixedEdges[i] = { ...fixedEdges[i]!, to: mergeId };
        }
      }
      // Single edge: mergeId → target
      fixedEdges.push({ from: mergeId, to: target });
      result.appliedFixes.push({
        type: 'fan_in_merge_inserted',
        nodeId: target,
        detail: `Inserito logic_merge "${mergeId}" prima di "${target}" (${String((incomingByTarget.get(target) ?? []).length)} branch convergenti, defId non-aggregator).`,
      });
    }
    result.nodes = newNodes;
    result.edges = fixedEdges;
  }

  return result;
}
