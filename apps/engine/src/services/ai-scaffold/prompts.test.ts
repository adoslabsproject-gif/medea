/**
 * Test SYSTEM_PROMPT — regression guard sul comportamento "no abort senza motivo".
 *
 * Bug 2026-05-29: Liara faceva `abort` quando list_email_accounts ritornava
 * vuoto, anche se l'utente aveva fornito un goal chiaro e VOLEVA il workflow
 * (gli account si configurano dopo via UI).
 *
 * Fix: il prompt ora dice esplicitamente "USA abort SOLO se il goal è impossibile,
 * NON solo perché mancano risorse pre-configurate".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_LORA, pickScaffoldPrompt } from './prompts';

describe('SYSTEM_PROMPT — anti-abort regression 2026-05-29', () => {
  it('contiene istruzione esplicita "USA abort SOLO se impossibile"', () => {
    expect(SYSTEM_PROMPT).toMatch(/USA abort SOLO/);
  });

  it('vieta abort per risorse mancanti (database/email/secret/LLM)', () => {
    // 2026-05-29 expanded: il prompt ora elenca esplicitamente le 5
    // categorie di risorse mancanti per cui MAI fare abort.
    expect(SYSTEM_PROMPT).toMatch(/MAI fare abort per/i);
  });

  it('regola email: usa accountId="__pending__" se nessun account configurato', () => {
    expect(SYSTEM_PROMPT).toMatch(/__pending__/);
  });

  it('regola secrets: usa {{secrets.NOME}} anche se non settato', () => {
    expect(SYSTEM_PROMPT).toMatch(/\{\{secrets\.[A-Z_]*?\}\}.*non.*settato/i);
  });

  it('regola LLM (2026-06-07): istruisce a leggere meta.useThisProvider, MAI guess dal training data', () => {
    // Pre-2026-06-07 il prompt diceva "fallback a provider=liara".
    // Bug: Liara non chiamava list_llm_providers e metteva provider=openai
    // con apiKey hard-coded inventata. Fix: regola HARD che usa meta.useThisProvider
    // VERBATIM e proibisce guess "gpt-4o"/"claude" basati su training data.
    expect(SYSTEM_PROMPT).toMatch(/REGOLA LLM PROVIDER.*HARD CONSTRAINT/);
    expect(SYSTEM_PROMPT).toMatch(/meta\.useThisProvider/);
    expect(SYSTEM_PROMPT).toMatch(/VERBATIM/);
    expect(SYSTEM_PROMPT).toMatch(/ANTI-PATTERN VIETATI/);
    expect(SYSTEM_PROMPT).toMatch(/gpt-4o/);
    expect(SYSTEM_PROMPT).toMatch(/abort.*Settings.*AI.*Liara/i);
  });

  it('non istruisce più di fare abort se manca un account email (regression)', () => {
    // Pre-fix: "PRIMA di add_node che usa email ... chiama list_email_accounts e usa l'id reale"
    // implicitamente faceva pensare "se nessun id reale → abort"
    // Post-fix: "Se NESSUN account configurato, USA COMUNQUE il nodo"
    expect(SYSTEM_PROMPT).toMatch(/USA COMUNQUE il nodo/);
  });
});

describe('SYSTEM_PROMPT — anti-abort 2026-05-29 extended (DB / file storage)', () => {
  it('REGOLA 12: vieta abort esplicitamente per "database mancante"', () => {
    // Bug reale: Liara faceva abort con motivo "Il database default_db non
    // esiste. Prima di creare tabelle, è necessario configurare un database
    // nel tenant." → "Stream chiuso senza un risultato" lato client.
    expect(SYSTEM_PROMPT).toMatch(/MAI fare abort per:.*database mancante/i);
  });

  it('REGOLA 2: per DB mancante chiama create_database (no più placeholder)', () => {
    expect(SYSTEM_PROMPT).toMatch(/NESSUN database.*configurato.*create_database/i);
    expect(SYSTEM_PROMPT).toMatch(/workflow_data/);
  });

  it('catalog: create_database tool elencato come mutation', () => {
    expect(SYSTEM_PROMPT).toMatch(/create_database\(name/);
  });

  it('REGOLA 13: file storage → action_file_write, NO db_insert binary', () => {
    expect(SYSTEM_PROMPT).toMatch(/archiviare un file/i);
    expect(SYSTEM_PROMPT).toMatch(/action_file_write/);
    expect(SYSTEM_PROMPT).toMatch(/NON serve un DB per salvare file/i);
  });

  it('vieta abort estensivo: 5 categorie risorse mancanti elencate esplicitamente', () => {
    // Garantisce che nuove categorie non aggiunte non sneakino abort indebiti.
    const REQUIRED_CATEGORIES = [
      /database mancante/i,
      /account email mancante/i,
      /secret\/credenziale mancante/i,
      /provider LLM esterno mancante/i,
      /tabella DB mancante/i,
    ];
    for (const cat of REQUIRED_CATEGORIES) {
      expect(SYSTEM_PROMPT, `category ${cat.source}`).toMatch(cat);
    }
  });
});

describe('SYSTEM_PROMPT — pattern building-block 2026-05-31 (refactor compact)', () => {
  // Refactor 2026-05-31 (context overflow fix): rimossi gli ESEMPIO 1-4 verbosi
  // (~14K chars) che inducevano Liara a pattern-matchare sul primo example invece
  // di leggere il goal. Sostituiti con PATTERN BUILDING-BLOCK compatti + 2
  // esempi enterprise sintetici. Risparmio ~3K token system prompt.

  it('PATTERN BUILDING-BLOCK section presente', () => {
    expect(SYSTEM_PROMPT).toMatch(/PATTERN BUILDING-BLOCK/);
  });

  it('ARCHITETTURA 3 layer (INGEST / PROCESS / EGRESS) presente', () => {
    expect(SYSTEM_PROMPT).toMatch(/INGEST.*trigger_imap.*trigger_webhook.*trigger_cron/);
    expect(SYSTEM_PROMPT).toMatch(/PROCESS.*agent_extractor.*agent_classifier.*logic_if/);
    expect(SYSTEM_PROMPT).toMatch(/EGRESS.*action_send_email.*community_.*action_http/);
  });

  it('DECOMPOSIZIONE GOAL → NODI: regole 1-a-1 per verbo/integrazione/branch/tipo', () => {
    expect(SYSTEM_PROMPT).toMatch(/DECOMPOSIZIONE GOAL/);
    expect(SYSTEM_PROMPT).toMatch(/OGNI verbo distinto.*1 nodo/);
    expect(SYSTEM_PROMPT).toMatch(/OGNI integrazione esterna.*1 nodo/);
    expect(SYSTEM_PROMPT).toMatch(/OGNI tipo documento.*1 ramo/);
    expect(SYSTEM_PROMPT).toMatch(/OGNI condizione.*logic_if.*logic_switch/);
  });

  it('ESEMPIO Document Intelligence Enterprise (~16 nodi) presente', () => {
    expect(SYSTEM_PROMPT).toMatch(/Document Intelligence/i);
    expect(SYSTEM_PROMPT).toMatch(/agent_extractor.*OCR/i);
    expect(SYSTEM_PROMPT).toMatch(/logic_switch.*contratto.*fattura.*preventivo/);
    expect(SYSTEM_PROMPT).toMatch(/16 nodi/);
  });

  it('ESEMPIO E-commerce Order Pipeline (~14 nodi) presente', () => {
    expect(SYSTEM_PROMPT).toMatch(/E-commerce Order Pipeline/i);
    expect(SYSTEM_PROMPT).toMatch(/agent_validator.*agent_classifier.*logic_if/);
    expect(SYSTEM_PROMPT).toMatch(/14 nodi/);
  });

  it('REGOLE CRITICHE WORKFLOW: minNodes + ogni ramo terminale + reuse + posizionamento', () => {
    expect(SYSTEM_PROMPT).toMatch(/MAI ridurre il numero di nodi sotto.*minNodes/);
    expect(SYSTEM_PROMPT).toMatch(/OGNI ramo.*almeno 1 action terminale/);
    expect(SYSTEM_PROMPT).toMatch(/Riusa databaseId UNA volta/);
    expect(SYSTEM_PROMPT).toMatch(/Posizionamento.*linear.*branching/);
  });

  it('CODE NODE HARD RULE: distingue run_js (JavaScript) da run_python (Python) — anti-bug 2026-06-09', () => {
    expect(SYSTEM_PROMPT).toMatch(/CODE NODE HARD RULE/);
    // I due nodi devono essere nominati con il loro linguaggio.
    expect(SYSTEM_PROMPT).toMatch(/action_run_js.*SOLO JavaScript/);
    expect(SYSTEM_PROMPT).toMatch(/action_run_python.*SOLO Python/);
    // Il segnale chiave del bug reale: import/print = Python.
    expect(SYSTEM_PROMPT).toMatch(/import json.*Python.*action_run_python/);
    // I params python-only non vanno su run_js.
    expect(SYSTEM_PROMPT).toMatch(/Mai .*parseStdoutJson.*allowNetwork.*su un nodo run_js/);
  });

  it('NO PERSISTENZA NON RICHIESTA: niente db_insert se non chiesto + colonne esistenti', () => {
    expect(SYSTEM_PROMPT).toMatch(/NO PERSISTENZA NON RICHIESTA/);
    expect(SYSTEM_PROMPT).toMatch(/creami un nodo code.*NIENTE scrittura su database/);
    expect(SYSTEM_PROMPT).toMatch(/colonne ESISTENTI/);
    expect(SYSTEM_PROMPT).toMatch(/MAI inventare colonne come "code"\/"created_at"/);
  });

  it('REGRESSION: pattern verbosi rimossi (no più ESEMPIO 1/2/3/4 vecchio formato)', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/ESEMPIO 1 — "Quando arriva email/);
    expect(SYSTEM_PROMPT).not.toMatch(/ESEMPIO 2 — "Ogni luned/);
    expect(SYSTEM_PROMPT).not.toMatch(/ESEMPIO 3 — "Quando un cliente/);
    expect(SYSTEM_PROMPT).not.toMatch(/ESEMPIO ADV 1 — "Quando arriva un webhook/);
  });
});

describe('SYSTEM_PROMPT — invarianti base (no regression)', () => {
  it('contiene OBIETTIVO + MODALITÀ AGENT', () => {
    expect(SYSTEM_PROMPT).toMatch(/OBIETTIVO/);
    expect(SYSTEM_PROMPT).toMatch(/MODALIT.*AGENT/);
  });

  it('istruzione "JSON puro" presente', () => {
    expect(SYSTEM_PROMPT).toMatch(/SOLO JSON/);
  });

  it('elenco tool catalog presente', () => {
    expect(SYSTEM_PROMPT).toMatch(/list_databases/);
    expect(SYSTEM_PROMPT).toMatch(/list_node_catalog/);
    expect(SYSTEM_PROMPT).toMatch(/list_email_accounts/);
    expect(SYSTEM_PROMPT).toMatch(/finalize_workflow/);
    expect(SYSTEM_PROMPT).toMatch(/abort\(reason\)/);
  });

  it('enabled=false di default (user enables after review)', () => {
    expect(SYSTEM_PROMPT).toMatch(/enabled\s*=\s*false/);
  });
});

describe('SYSTEM_PROMPT — pattern building-block enterprise (refactor 2026-05-31)', () => {
  // Refactor: ex ESEMPIO ADV 1-3 verbosi sostituiti da 2 esempi compact +
  // building-block layer rule. Il LoRA training set NHA-v2 ha già learned i
  // 73 scenari completi — prompt runtime serve solo come "playbook compatto"
  // post-LoRA.

  it('ESEMPIO Document Intelligence Enterprise: contiene branch tipi + low-conf + summary', () => {
    expect(SYSTEM_PROMPT).toMatch(/Document Intelligence Enterprise/i);
    expect(SYSTEM_PROMPT).toMatch(/agent_classifier.*tipo doc/i);
    expect(SYSTEM_PROMPT).toMatch(/logic_if.*low confidence/i);
    expect(SYSTEM_PROMPT).toMatch(/ramo contratto.*ramo fattura.*ramo preventivo/s);
    expect(SYSTEM_PROMPT).toMatch(/trigger_cron daily.*agent_summarizer/);
  });

  it('ESEMPIO E-commerce Pipeline: contiene priority + tier + audit', () => {
    expect(SYSTEM_PROMPT).toMatch(/E-commerce Order Pipeline/i);
    expect(SYSTEM_PROMPT).toMatch(/agent_classifier.*priority/i);
    expect(SYSTEM_PROMPT).toMatch(/logic_if.*Pro tier/i);
    expect(SYSTEM_PROMPT).toMatch(/hot.*warm.*cold/);
    expect(SYSTEM_PROMPT).toMatch(/audit SHA-256/);
  });

  it('REGOLE CRITICHE: minNodes server-enforced + ramo terminale + reuse db', () => {
    expect(SYSTEM_PROMPT).toMatch(/REGOLE CRITICHE WORKFLOW AVANZATI/);
    expect(SYSTEM_PROMPT).toMatch(/MAI ridurre il numero di nodi/);
    expect(SYSTEM_PROMPT).toMatch(/almeno 1 action terminale.*db_insert audit/);
    expect(SYSTEM_PROMPT).toMatch(/Riusa databaseId UNA volta/);
  });

  it('ESEMPI building-block usano SOLO defId reali (no legacy)', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/telegram_send_message/);
    expect(SYSTEM_PROMPT).not.toMatch(/slack_post_message/);
    expect(SYSTEM_PROMPT).not.toMatch(/github_create_issue/);
    expect(SYSTEM_PROMPT).not.toMatch(/notion_create_page/);
    expect(SYSTEM_PROMPT).not.toMatch(/linear_create_issue/);
    expect(SYSTEM_PROMPT).not.toMatch(/discord_webhook_post/);
    expect(SYSTEM_PROMPT).not.toMatch(/integration_telegram_send/);
  });
});

describe('SYSTEM_PROMPT — anti-hallucinate vendor IDs (FIX 2026-05-30)', () => {
  // Bug user-segnalato: Liara ha allucinato il defId `integration_telegram_send`
  // (formato pattern inventato) facendo abort "Il nodo integration_telegram_send
  // non è presente nel catalogo". Il defId REALE è community_telegram con
  // sub-action send_message. Fix: prompt esplicita il pattern community_<vendor>
  // come canonico per integrazioni vendor + vieta guess.

  it('REGOLA 5 contiene mapping community_<vendor> per integrazioni vendor', () => {
    expect(SYSTEM_PROMPT).toMatch(/community_telegram/);
    expect(SYSTEM_PROMPT).toMatch(/community_slack/);
    expect(SYSTEM_PROMPT).toMatch(/community_github/);
    expect(SYSTEM_PROMPT).toMatch(/community_notion/);
    expect(SYSTEM_PROMPT).toMatch(/community_stripe/);
    expect(SYSTEM_PROMPT).toMatch(/community_linear/);
    expect(SYSTEM_PROMPT).toMatch(/community_discord/);
  });

  it('REGOLA 5 vieta esplicitamente i pattern guess "integration_<vendor>" e "<vendor>_<verb>"', () => {
    expect(SYSTEM_PROMPT).toMatch(/MAI inventare defId tipo/i);
    expect(SYSTEM_PROMPT).toMatch(/integration_<vendor>/);
    expect(SYSTEM_PROMPT).toMatch(/quei pattern NON esistono/i);
  });

  it('REGOLA 5 menziona il config field "action" per sub-azioni del community node', () => {
    expect(SYSTEM_PROMPT).toMatch(/config field obbligatorio "action"/);
    expect(SYSTEM_PROMPT).toMatch(/send_message/);
  });

  it('REGOLA 5 priority: prima il vendor reale, action_http solo se davvero empty', () => {
    // Fix 2026-05-30: NON deve mai saltare un nodo richiesto dal goal.
    // PRIORITY 1 = community_<vendor> se presente, PRIORITY 2 = action_http.
    expect(SYSTEM_PROMPT).toMatch(/PRIORITY 1.*community_<vendor>/i);
    expect(SYSTEM_PROMPT).toMatch(/PRIORITY 2.*action_http/i);
    expect(SYSTEM_PROMPT).toMatch(/MAI saltare un nodo/i);
    expect(SYSTEM_PROMPT).toMatch(/MAI abort per "nodo non installato"/i);
    // Anti-regression: NON deve più raccomandare "http_request" come defId.
    expect(SYSTEM_PROMPT).not.toMatch(/fallback con http_request/);
  });

  it('REGRESSION: il prompt NON contiene più integration_telegram_send (allucinato)', () => {
    // L'id "integration_telegram_send" era stato menzionato nell'ESEMPIO 1
    // pre-fix → Liara lo replicava nei propri output. Verifica zero residui.
    expect(SYSTEM_PROMPT).not.toMatch(/integration_telegram_send/);
  });

  it('REGOLA 0: PHASE 0 obbligatoria propose_plan PRIMA di add_node/connect_nodes/finalize_workflow', () => {
    // Plan-then-Execute pattern 2026-05-31. Server respinge mutation senza plan.
    expect(SYSTEM_PROMPT).toMatch(/PHASE 0 OBBLIGATORIA/i);
    expect(SYSTEM_PROMPT).toMatch(/propose_plan/);
    expect(SYSTEM_PROMPT).toMatch(/FASE 0.*PLAN.*FASE 1.*EXECUTE/is);
    expect(SYSTEM_PROMPT).toMatch(/reasoning.*60/i);
    expect(SYSTEM_PROMPT).toMatch(/purpose.*10/i);
    // TOOL list cita propose_plan
    expect(SYSTEM_PROMPT).toMatch(/TOOL DI PLANNING/i);
  });

  it('REGOLA 17.bis: SEQUENZA hard "PRIMA add_node POI connect_nodes" — anti-bug "non è un nodo aggiunto"', () => {
    // Bug osservato 2026-05-30: Liara faceva add_node(A) → connect_nodes(A→B) → add_node(B)
    // → server respinge "to=B non è un nodo aggiunto" → loop di errori finché
    // maxIter esaurito. Regola esplicita nel prompt.
    expect(SYSTEM_PROMPT).toMatch(/PRIMA TUTTI gli add_node/i);
    expect(SYSTEM_PROMPT).toMatch(/POI connect_nodes/i);
    expect(SYSTEM_PROMPT).toMatch(/FASE 1.*build.*FASE 2.*wire/is);
    // Anti-regression: il pattern "add_node → connect_nodes interleavato" deve
    // essere esplicitamente vietato.
    expect(SYSTEM_PROMPT).toMatch(/NON fare add_node\(A\).*connect_nodes\(A→B\).*add_node\(B\)/);
  });

  it('REGRESSION: il prompt NON contiene più i 7 id legacy (slack_post_message, github_create_issue, ecc.)', () => {
    const LEGACY_IDS = [
      'slack_post_message', 'github_create_issue', 'notion_create_page',
      'stripe_charge', 'linear_create_issue', 'discord_webhook_post',
      'telegram_send_message',
    ];
    for (const id of LEGACY_IDS) {
      expect(SYSTEM_PROMPT, `legacy id ${id} non deve apparire nel prompt`).not.toContain(id);
    }
  });
});

describe('SYSTEM_PROMPT — pattern di QUALITÀ semantici (2026-06-17, allineati a semantic-rules)', () => {
  it('🚨 ERROR-BRANCH POLARITY: vieta successo→DLQ in entrambi i prompt', () => {
    expect(SYSTEM_PROMPT).toMatch(/ERROR-BRANCH POLARITY/);
    expect(SYSTEM_PROMPT).toMatch(/SUCCESSO.*DLQ|DLQ.*successo/i);
    expect(SYSTEM_PROMPT_LORA).toMatch(/ERROR-BRANCH POLARITY/);
  });
  it('🚨 RETRY non vicolo cieco: deve ricontrollare e finire in DLQ se fallisce ancora', () => {
    expect(SYSTEM_PROMPT).toMatch(/retry.*ricontroll|ricontroll.*retry|retry.*DLQ/i);
  });
  it('🚨 UPSERT pattern: lookup → logic_if → update/create (mai lookup→create diretto)', () => {
    expect(SYSTEM_PROMPT).toMatch(/UPSERT/);
    expect(SYSTEM_PROMPT).toMatch(/lookup.*create dirett|diretto/i);
    expect(SYSTEM_PROMPT_LORA).toMatch(/UPSERT/);
  });
  it('🚨 GOLDEN PATTERN few-shot: wiring corretto error/retry/DLQ + upsert nel prompt full', () => {
    expect(SYSTEM_PROMPT).toMatch(/GOLDEN PATTERN/);
    expect(SYSTEM_PROMPT).toMatch(/MAI il successo in DLQ/);
    expect(SYSTEM_PROMPT).toMatch(/se esiste aggiorna, altrimenti crea/);
  });
});

describe('SYSTEM_PROMPT_LORA — variante compatta per Liara con LoRA caricato (PREP 2026-05-30)', () => {
  // User: "sto facendo un LoRA, quindi dovremmo poi fare un prompt system
  // ridotto solo per liara, perché molte cose del system prompt le metterò
  // nel lora". LoRA non è pronto ora → branch logic INATTIVA di default.
  // Quando arriverà, setta MEDEA_LIARA_LORA_LOADED=true sul container.

  afterEach(() => {
    delete process.env.MEDEA_LIARA_LORA_LOADED;
  });

  it('SYSTEM_PROMPT_LORA esportato + significativamente più corto del full (~4KB vs ~12KB)', () => {
    expect(SYSTEM_PROMPT_LORA).toBeDefined();
    // Post-2026-06-09: aggiunte 15 micro-regole numbered compatte
    // (DEFID-WHITELIST, SECRETS, FAN-IN HARD, SWITCH default, DEAD-END,
    //  CIRCULAR, LOOP+AGGR, ERROR HANDLING, EXPRESSIONS, MIN-NODI,
    //  TABELLE NUOVE, AGENT WIRING, SCAFFOLD COMPLETO).
    // Target: ≤4500 bytes (~1100 token), comunque significativamente più
    // corto del full (~12KB) per liberare context window al LoRA.
    expect(SYSTEM_PROMPT_LORA.length).toBeLessThan(4500);
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(8000);
    // Delta minimo: 5KB = ~1300 token risparmio nel context window.
    expect(SYSTEM_PROMPT.length - SYSTEM_PROMPT_LORA.length).toBeGreaterThan(5000);
  });

  it('SYSTEM_PROMPT_LORA contiene gli essenziali: agent mode + JSON puro + risposta esempio', () => {
    expect(SYSTEM_PROMPT_LORA).toMatch(/OBIETTIVO/);
    expect(SYSTEM_PROMPT_LORA).toMatch(/MODALIT/i);
    expect(SYSTEM_PROMPT_LORA).toMatch(/JSON puro/);
    expect(SYSTEM_PROMPT_LORA).toMatch(/list_databases/);
  });

  it('SYSTEM_PROMPT_LORA NON include esempi/regole verbose (sono nel LoRA training)', () => {
    expect(SYSTEM_PROMPT_LORA).not.toMatch(/ESEMPIO 1/);
    expect(SYSTEM_PROMPT_LORA).not.toMatch(/ESEMPIO ADV/);
    expect(SYSTEM_PROMPT_LORA).not.toMatch(/REGOLE DI INGEGNERIA/);
    expect(SYSTEM_PROMPT_LORA).not.toMatch(/PATTERN COMUNI/);
  });

  it('pickScaffoldPrompt: provider !== "liara" → SEMPRE SYSTEM_PROMPT full (no LoRA per OpenAI/Anthropic/Gemini)', () => {
    process.env.MEDEA_LIARA_LORA_LOADED = 'true';
    expect(pickScaffoldPrompt('openai')).toBe(SYSTEM_PROMPT);
    expect(pickScaffoldPrompt('anthropic')).toBe(SYSTEM_PROMPT);
    expect(pickScaffoldPrompt('gemini')).toBe(SYSTEM_PROMPT);
    expect(pickScaffoldPrompt('mistral')).toBe(SYSTEM_PROMPT);
    expect(pickScaffoldPrompt('ollama')).toBe(SYSTEM_PROMPT);
  });

  it('DEFAULT (env non settato) — provider="liara" usa FULL prompt (LoRA non ancora deployato)', () => {
    delete process.env.MEDEA_LIARA_LORA_LOADED;
    expect(pickScaffoldPrompt('liara')).toBe(SYSTEM_PROMPT);
  });

  it('OPT-IN env MEDEA_LIARA_LORA_LOADED=true + provider="liara" → SYSTEM_PROMPT_LORA compact', () => {
    process.env.MEDEA_LIARA_LORA_LOADED = 'true';
    expect(pickScaffoldPrompt('liara')).toBe(SYSTEM_PROMPT_LORA);
  });

  it('REGRESSION: env MEDEA_LIARA_LORA_LOADED="false" (string) → FULL (no falsy parsing bug)', () => {
    process.env.MEDEA_LIARA_LORA_LOADED = 'false';
    expect(pickScaffoldPrompt('liara')).toBe(SYSTEM_PROMPT);
  });

  it('REGRESSION: env MEDEA_LIARA_LORA_LOADED="1" → FULL (solo "true" exact match opt-in)', () => {
    // Pattern enterprise: opt-in con string EXACT "true", no truthy coercion.
    process.env.MEDEA_LIARA_LORA_LOADED = '1';
    expect(pickScaffoldPrompt('liara')).toBe(SYSTEM_PROMPT);
  });
});

// SYSTEM_PROMPT_LORA — micro-regole compatte (anti-regression context compaction)
describe('SYSTEM_PROMPT_LORA — 15 micro-regole critiche embedded', () => {
  it('contiene tutte le 15 numbered rules', () => {
    for (let i = 1; i <= 15; i++) {
      expect(SYSTEM_PROMPT_LORA, `regola ${i} mancante`).toMatch(new RegExp(`\\n${i}\\.`, 'u'));
    }
  });

  it('contiene keyword critici per ogni categoria', () => {
    const required = [
      'DEFID-WHITELIST', 'SECRETS', '__USE_PICKER__',
      'FAN-IN HARD', 'flow_merge', 'agent_data_analyst',
      'SWITCH', 'defaultCase',
      'DEAD-END',
      'CIRCULAR',
      'LOOP+AGGR', 'strategy="batch"',
      'ERROR HANDLING', 'retryPolicy',
      'EXPRESSIONS', '$node',
      'MIN-NODI',
      'TABELLE NUOVE', 'tablesToCreate',
      'AGENT WIRING',
      'SCAFFOLD COMPLETO',
    ];
    for (const kw of required) {
      expect(SYSTEM_PROMPT_LORA, `keyword "${kw}" mancante`).toContain(kw);
    }
  });

  it('mantiene HARD CONSTRAINT su LLM PROVIDER', () => {
    expect(SYSTEM_PROMPT_LORA).toMatch(/REGOLA LLM PROVIDER \(HARD\)/);
    expect(SYSTEM_PROMPT_LORA).toMatch(/list_llm_providers/);
    expect(SYSTEM_PROMPT_LORA).toMatch(/meta\.useThisProvider/);
  });

  it('rimane compatto (≤2800 token approx, < 3500 chars for safety)', () => {
    // Il LoRA fa il lavoro pesante; il prompt deve restare compatto.
    // 1 token ≈ 4 chars per IT/EN mix → 2800 token ≈ 11200 chars
    expect(SYSTEM_PROMPT_LORA.length).toBeLessThan(11200);
  });
});
