/**
 * action_llm_complete — chiamata LLM generica enterprise (Liara gateway).
 *
 * Use case: qualsiasi nodo workflow che ha bisogno di "Liara, fai X con questo
 * testo" SENZA dover assemblare un agent_* specifico. Pattern utilizzato in
 * cataloghi/prompt dei nodi e nei dataset LoRA AI scaffold.
 *
 * Output: { completion, model, provider, tokensUsed:{prompt,completion,total},
 *           cost?, responseFormat, jsonParsed? }
 *
 * Implementazione executor in `apps/engine/src/executors/llm-complete.ts`.
 * NOMI CAMPI matchano ESATTAMENTE i `config.X` letti dall'executor.
 */

import type { NodeModule } from '../types.js';

export const llmCompleteNode: NodeModule = {
  def: {
    id: 'action_llm_complete',
    type: 'action',
    label: 'LLM: completion generica',
    icon: 'sparkles',
    color: '#a855f7',
    description:
      'Nodo generico LLM (Large Language Model) per generazione open-ended di testo o JSON strutturato, da ' +
      'qualsiasi prompt e con il provider configurato — la primitiva atomic di accesso alle capacità AI ' +
      'sottostanti la quale sono costruiti gli agent_* specializzati. Default: Liara Qwen3-32B FP8 self-hosted ' +
      'on-prem (vLLM su Hetzner Blackwell GEX131 RTX PRO 6000 96GB Falkenstein DE — zero trasferimento dati ' +
      'extra-UE, latenza p50 800ms, costo zero per il cliente nelle quote del piano). Override via BYOK con uno ' +
      'dei 9 provider esterni supportati: Anthropic Claude Sonnet 4 (state-of-art reasoning, $3/MTok input), OpenAI GPT-4o ' +
      '($2.5/MTok input), Google Gemini 2.0 Flash (long-context, multimodale), DeepSeek-V3 ($0.27/MTok input, sweet spot ' +
      'prezzo/qualità), xAI Grok-2, OpenRouter (aggregator multi-modello), Mistral Large, Groq (LPU inference ultra-veloce ' +
      'su Llama-3 e Mixtral), Perplexity Sonar (web search integrata con citazioni live). Routing automatico via header ' +
      'X-FF-Provider gestito dal gateway LLM portal con quota ' +
      'mensile dedicata BYOK separata da Liara. ' +
      'Modalità output: testo plain (default — generazione discorsiva libera) oppure JSON structured ' +
      '(prompt include schema target + response_format json_object per Anthropic/OpenAI, fallback parsing per ' +
      'altri provider — validation downstream con Zod schema raccomandata). Temperature configurabile (0.0 ' +
      'deterministic per classifier, 0.7 default balanced, 1.0 creative per copywriting). max_tokens cap per ' +
      'controllo costo. ' +
      'Use case: scrittura di risposta email personalizzata multilingua per customer support B2B che integra ' +
      'context del cliente da memory_note (ordini precedenti, ticket aperti, preferenze comunicazione); ' +
      'generazione di descrizioni prodotto e-commerce SEO-friendly a partire dalla scheda tecnica raw del ' +
      'fornitore; classificazione di testo libero in categorie business custom non coperte da agent_* ' +
      'pre-tunati (es. classifier su 50 categorie merceologiche del settore agroalimentare); estrazione di ' +
      'entità strutturate da unstructured text (es. parse di paragrafi PEC ricevuti per estrarre ' +
      'partita_iva+importo+data_scadenza in JSON pronto per ingest contabile); brainstorming di idee marketing ' +
      'su brief ridotto per content creator. ' +
      'IMPORTANTE: se hai un task specifico ricorrente (triage email, sales reply, summarizer, translation, ' +
      'classifier ufficiale, intent routing), preferisci gli agent_* dedicati — sono pre-tunati con prompt ' +
      'engineering ottimizzato per quel task specifico, hanno output schema fisso testato, error handling ' +
      'specializzato, e tipicamente 2-3× più accurate vs prompt generico al action_llm_complete.',
    configFields: [
      {
        key: 'systemPrompt',
        label: 'System prompt (istruzioni base)',
        type: 'textarea',
        required: false,
        placeholder: 'Sei un assistente che risponde sempre in italiano formale.',
        help: 'Comportamento base del LLM. Vuoto = nessun system prompt (modello in "default mode"). ' +
          'Usato per impostare tono, lingua, formato output, vincoli ("rispondi solo con JSON" etc).',
      },
      {
        key: 'prompt',
        label: 'Prompt utente',
        type: 'textarea',
        required: true,
        placeholder: 'Riassumi questa email in 3 frasi:\n\n{{$node.ImapTrigger.json.body}}',
        help: 'Il messaggio principale che il LLM riceve. Supporta {{espressioni}} per iniettare ' +
          'output di nodi precedenti, {{secrets.X}} per credenziali, {{vars.X}} per variabili.',
      },
      {
        key: 'provider',
        label: 'Provider LLM',
        type: 'select',
        required: false,
        options: ['liara', 'anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'deepseek', 'xai', 'perplexity'],
        defaultValue: 'liara',
        help: 'liara (default) = Qwen3 32B self-hosted ZeliAI, GRATIS sul tuo piano. ' +
          'Gli altri richiedono BYOK API key configurata in Settings → AI Providers e sono a tuo carico.',
      },
      {
        key: 'model',
        label: 'Modello (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'claude-sonnet-4-6 / gpt-4o-mini / lascia vuoto per default provider',
        help: 'Vuoto = usa il default del provider (Liara: qwen3-32b, Anthropic: claude-sonnet-4-6, ' +
          'OpenAI: gpt-4o-mini). Per modelli specifici, inserisci l\\\'id esatto del provider.',
      },
      {
        key: 'temperature',
        label: 'Temperature (creatività)',
        type: 'number',
        required: false,
        defaultValue: '0.7',
        help: '0 = output deterministico (stesso input → stesso output, ideale per estrazione/classificazione). ' +
          '0.7 = bilanciato (default, ok per riassunti). 1.5+ = molto creativo (brainstorming, riformulazione).',
      },
      {
        key: 'maxTokens',
        label: 'Max tokens output',
        type: 'number',
        required: false,
        defaultValue: '2048',
        help: 'Lunghezza massima della risposta in token (~3-4 char per token IT/EN). 2048 = ~6000 char, ' +
          'sufficiente per un\\\'email lunga o un\\\'estrazione JSON di 30 campi. Aumenta a 8192+ solo per ' +
          'output lunghi (report, analisi).',
      },
      {
        key: 'responseFormat',
        label: 'Formato risposta',
        type: 'select',
        required: false,
        options: ['text', 'json'],
        defaultValue: 'text',
        help: 'text = stringa libera (default). json = forza il LLM a rispondere con JSON valido (parsato ' +
          'in output.jsonParsed automaticamente). Per json, suggerisci la struttura nel prompt: ' +
          '"Rispondi SOLO con {key1, key2, ...}".',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        required: false,
        defaultValue: '60000',
        help: 'Massimo tempo di attesa risposta. 60000 = 1 min (default). LLM lunghi (reasoning + output >2k token) ' +
          'possono richiedere 90-180s — aumenta se vedi timeout.',
      },
    ],
    outputs: ['completion', 'model', 'provider', 'tokensUsed', 'responseFormat', 'jsonParsed', 'cost', 'finishReason'],
    vendor: 'flowforge',
    version: '1.0.0',
    cost: {
      // Liara self-hosted: ~$0 (costo elettrico GPU ammortizzato).
      // Anthropic Sonnet: ~$0.003 input + $0.015 output per call media (1k+500 tok).
      // Stimator UI userà questo per "stima costo workflow di N call".
      costPerCall: 0.005,
      typicalLatencyMs: 3000,
    },
  },
};
