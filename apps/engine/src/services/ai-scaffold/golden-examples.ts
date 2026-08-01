/**
 * GOLDEN EXAMPLES — libreria curata di workflow canonici per il few-shot
 * COLD-START dello scaffold.
 *
 * Il template-cache fa few-shot solo da workflow auto-generati: su un tenant
 * nuovo (cache vuota) Liara genera senza alcun esempio. Questi 5 pattern
 * FATTI A MANO coprono le richieste più comuni e vengono iniettati nel prompt
 * quando la cache non ha match — il modello vede com'è fatto un workflow
 * GIUSTO (config reali, {{secrets.*}} per i valori ignoti, __USE_PICKER__
 * per le risorse, espressioni $node corrette) invece di inventare.
 *
 * MANUTENZIONE = il contract test golden-examples.contract.test.ts: ogni
 * esempio è validato in CI contro il CATALOGO REALE (defId esistenti,
 * required presenti, valori select ammessi, quality-gate pulito, dataflow
 * raggiungibile). Se un NodeDef cambia, il CI indica l'esempio da aggiornare:
 * gli esempi NON possono driftare in silenzio.
 */
import { tokenize } from '@/services/catalog-retrieval/index-builder.js';

export interface GoldenExample {
  id: string;
  /** Termini (già canonizzati dal tokenizer) che attivano questo esempio. */
  keywords: readonly string[];
  /** Titolo umano mostrato nel prompt. */
  title: string;
  workflow: {
    name: string;
    nodes: { id: string; defId: string; config: Record<string, string>; x: number; y: number }[];
    edges: { from: string; to: string; fromPort?: string }[];
  };
}

export const GOLDEN_EXAMPLES: readonly GoldenExample[] = [
  {
    id: 'api-to-db',
    keywords: ['webhook', 'api', 'db', 'database', 'salva', 'insert', 'endpoint'],
    title: 'API endpoint che valida e salva nel database',
    workflow: {
      name: 'API → valida → salva → rispondi',
      nodes: [
        { id: 'ricevi_richiesta', defId: 'trigger_webhook', config: { method: 'POST' }, x: 0, y: 0 },
        { id: 'valida_payload', defId: 'action_run_js', config: { code: 'const d = input; if (!d || !d.email) { return { valid: false, error: "email mancante" }; } return { valid: true, email: String(d.email).toLowerCase(), name: d.name || "" };' }, x: 240, y: 0 },
        { id: 'salva_contatto', defId: 'db_insert', config: { databaseId: '__USE_PICKER__', table: '__USE_PICKER__' }, x: 480, y: 0 },
        { id: 'rispondi', defId: 'action_webhook_respond', config: { respondWith: 'json' }, x: 720, y: 0 },
      ],
      edges: [
        { from: 'ricevi_richiesta', to: 'valida_payload' },
        { from: 'valida_payload', to: 'salva_contatto' },
        { from: 'salva_contatto', to: 'rispondi' },
      ],
    },
  },
  {
    id: 'daily-report',
    keywords: ['cron', 'schedule', 'report', 'giorno', 'giornaliero', 'mattina', 'email', 'mail', 'http'],
    title: 'Report giornaliero: API → filtro → email',
    workflow: {
      name: 'Report giornaliero via email',
      nodes: [
        { id: 'ogni_mattina', defId: 'trigger_cron', config: { cronExpression: '0 8 * * *' }, x: 0, y: 0 },
        { id: 'scarica_dati', defId: 'action_http', config: { method: 'GET', url: '{{secrets.REPORT_API_URL}}' }, x: 240, y: 0 },
        { id: 'filtra_attivi', defId: 'action_filter', config: { conditions: '{"combinator":"AND","rules":[{"field":"status","op":"equals","value":"active"}]}' }, x: 480, y: 0 },
        { id: 'invia_report', defId: 'action_send_email', config: { to: '{{secrets.REPORT_RECIPIENT}}', subject: 'Report giornaliero', bodyType: 'html', body: '<p>Elementi attivi: {{$node.filtra_attivi.json.keptCount}}</p>' }, x: 720, y: 0 },
      ],
      edges: [
        { from: 'ogni_mattina', to: 'scarica_dati' },
        { from: 'scarica_dati', to: 'filtra_attivi' },
        { from: 'filtra_attivi', to: 'invia_report', fromPort: 'kept' },
      ],
    },
  },
  {
    id: 'email-triage',
    keywords: ['email', 'mail', 'imap', 'triage', 'classifica', 'smista', 'spam', 'posta'],
    title: 'Triage email in arrivo con AI',
    workflow: {
      name: 'Triage email: classifica e smista',
      nodes: [
        { id: 'nuova_email', defId: 'trigger_imap', config: {}, x: 0, y: 0 },
        { id: 'classifica', defId: 'agent_classifier', config: { labels: 'supporto,vendite,spam' }, x: 240, y: 0 },
        { id: 'e_spam', defId: 'logic_if', config: { condition: "$node.classifica.json.label === 'spam'" }, x: 480, y: 0 },
        { id: 'log_spam', defId: 'db_insert', config: { databaseId: '__USE_PICKER__', table: '__USE_PICKER__' }, x: 720, y: -80 },
        { id: 'inoltra_al_team', defId: 'action_send_email', config: { to: '{{secrets.TEAM_INBOX}}', subject: 'Nuova email: {{$node.classifica.json.label}}', bodyType: 'text', body: 'Categoria: {{$node.classifica.json.label}} (confidenza {{$node.classifica.json.confidence}})' }, x: 720, y: 80 },
      ],
      edges: [
        { from: 'nuova_email', to: 'classifica' },
        { from: 'classifica', to: 'e_spam' },
        { from: 'e_spam', to: 'log_spam', fromPort: 'true' },
        { from: 'e_spam', to: 'inoltra_al_team', fromPort: 'false' },
      ],
    },
  },
  {
    id: 'form-to-db',
    keywords: ['form', 'modulo', 'contatto', 'lead', 'iscrizione', 'registrazione'],
    title: 'Form pubblico che salva e conferma via email',
    workflow: {
      name: 'Form contatti → DB → conferma',
      nodes: [
        { id: 'form_contatti', defId: 'trigger_form', config: { title: 'Richiesta contatto', fieldsJson: '[{"key":"nome","label":"Nome","type":"text","required":true},{"key":"email","label":"Email","type":"email","required":true}]', publicToken: '{{secrets.FORM_PUBLIC_TOKEN}}' }, x: 0, y: 0 },
        { id: 'salva_lead', defId: 'db_insert', config: { databaseId: '__USE_PICKER__', table: '__USE_PICKER__' }, x: 240, y: 0 },
        { id: 'conferma_iscrizione', defId: 'action_send_email', config: { to: '{{$node.form_contatti.json.email}}', subject: 'Abbiamo ricevuto la tua richiesta', bodyType: 'text', body: 'Ciao {{$node.form_contatti.json.nome}}, ti ricontatteremo presto.' }, x: 480, y: 0 },
      ],
      edges: [
        { from: 'form_contatti', to: 'salva_lead' },
        { from: 'salva_lead', to: 'conferma_iscrizione' },
      ],
    },
  },
  {
    id: 'rag-assistant',
    keywords: ['rag', 'knowledge', 'documenti', 'assistente', 'risposta', 'llm', 'chatbot'],
    title: 'Assistente RAG: domanda → contesto → risposta LLM',
    workflow: {
      name: 'Assistente sulla knowledge base',
      nodes: [
        { id: 'ricevi_domanda', defId: 'trigger_webhook', config: { method: 'POST' }, x: 0, y: 0 },
        { id: 'cerca_contesto', defId: 'rag_search', config: { databaseId: '__USE_PICKER__', collection: 'knowledge' }, x: 240, y: 0 },
        { id: 'genera_risposta', defId: 'action_llm_complete', config: { prompt: 'Rispondi usando SOLO il contesto seguente.\n\nContesto:\n{{$node.cerca_contesto.json}}\n\nDomanda: {{$node.ricevi_domanda.json.question}}' }, x: 480, y: 0 },
        { id: 'rispondi', defId: 'action_webhook_respond', config: { respondWith: 'json' }, x: 720, y: 0 },
      ],
      edges: [
        { from: 'ricevi_domanda', to: 'cerca_contesto' },
        { from: 'cerca_contesto', to: 'genera_risposta' },
        { from: 'genera_risposta', to: 'rispondi' },
      ],
    },
  },
];

/**
 * Seleziona il GOLD più pertinente al goal: overlap di token canonizzati
 * (stesso tokenizer del retriever) con le keywords del pattern. Nessun
 * overlap → null (meglio nessun esempio che un esempio fuorviante).
 */
export function pickGoldenExample(goal: string): GoldenExample | null {
  const goalTokens = new Set(tokenize(goal));
  let best: { ex: GoldenExample; score: number } | null = null;
  for (const ex of GOLDEN_EXAMPLES) {
    let score = 0;
    for (const k of ex.keywords) if (goalTokens.has(k)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { ex, score };
  }
  return best?.ex ?? null;
}

/** Blocco prompt few-shot per un GOLD (stesso formato del template-cache). */
export function formatGoldenExampleForPrompt(ex: GoldenExample): string {
  return [
    `### ESEMPIO CANONICO VALIDATO — "${ex.title}" (usa come riferimento STRUTTURALE: config reali, {{secrets.*}} per valori ignoti, __USE_PICKER__ per le risorse):`,
    '```json',
    JSON.stringify(ex.workflow, null, 2),
    '```',
    'Produci un workflow NUOVO ispirato all\'esempio ma specifico al goal corrente.',
  ].join('\n');
}
