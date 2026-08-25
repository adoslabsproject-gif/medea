/**
 * action_scrape_smart — orchestratore AI killer.
 *
 * Pipeline adaptive 4-stage:
 *   1. fetch_simple → HTML quick
 *   2. browser_render se HTML scarno (heuristic)
 *   3. browser_stealth se anti-bot challenge (Cloudflare/Akamai/DataDome)
 *   4. vision_extract se contenuto visually-only (canvas/PDF/SVG-heavy)
 *
 * + Liara LLM extract: prompt naturale + schema target → JSON
 * + Pagination auto-detect: rel="next", aria-label, text-match, URL pattern
 * + Multi-page follow (max pages config)
 *
 * Killer: un singolo nodo che fa quello che richiederebbe 5-10 nodi
 * orchestrati a mano. AI-powered + resiliente + observability completa.
 */

import type { NodeModule, NodeExecutor } from '../types.js';
import { logLlmExchange } from '../llm-exchange-log.js';
import { runPipeline } from './scrape-smart/pipeline.js';
import type { PipelineStage } from './scrape-smart/pipeline.js';
import { extractWithLlm } from './scrape-smart/extract-llm.js';
import { detectNextPage } from './scrape-smart/pagination.js';

interface PageResult {
  url: string;
  finalUrl: string;
  finalStage: PipelineStage;
  extracted: unknown;
  parseError: string | null;
  pipelineSteps: unknown[];
}

const executor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const url = String(config.url ?? '').trim();
  if (!url) throw new Error('url required');

  const prompt = String(config.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt required (descrivi cosa estrarre in italiano)');

  const schemaJson = String(config.schemaJson ?? '').trim() || undefined;
  if (schemaJson) {
    try {
      JSON.parse(schemaJson);
    } catch {
      throw new Error('schemaJson invalid JSON');
    }
  }

  const userAgent = String(config.userAgent ?? 'FlowForge-SmartScrape/1.0').trim();
  const browserEndpoint = String(
    config.browserEndpoint ?? process.env.MEDEA_BROWSER_ENDPOINT ?? '',
  ).trim();
  const browserApiKey = String(config.browserApiKey ?? '').trim();
  const stealthEndpoint = String(
    config.stealthEndpoint ?? process.env.MEDEA_STEALTH_ENDPOINT ?? '',
  ).trim();
  const stealthApiKey = String(config.stealthApiKey ?? '').trim();
  const liaraEndpoint = String(config.liaraEndpoint ?? '').trim() || undefined;
  const liaraApiKey = String(config.liaraApiKey ?? '').trim() || undefined;
  const liaraModel = String(config.liaraModel ?? '').trim() || undefined;

  const forceStageRaw = String(config.forceStage ?? 'auto').trim();
  const forceStage: PipelineStage | undefined =
    forceStageRaw === 'auto'
      ? undefined
      : ['fetch_simple', 'browser_render', 'browser_stealth', 'vision_extract'].includes(
            forceStageRaw,
          )
        ? (forceStageRaw as PipelineStage)
        : undefined;

  const timeoutMs = Math.max(5000, Math.min(Number(config.timeoutMs ?? 30_000), 120_000));
  const maxPages = Math.max(1, Math.min(Number(config.maxPages ?? 1), 50));
  const pageDelayMs = Math.max(0, Math.min(Number(config.pageDelayMs ?? 1000), 10_000));

  const pages: PageResult[] = [];
  let currentUrl = url;

  // Fase 2 (#14): usage cumulativo su TUTTE le pagine → un solo `_llm` per nodo.
  let totIn = 0;
  let totOut = 0;
  let allFromApi = true;
  let llmCalls = 0;
  let llmModel = '';
  let llmProvider = '';

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const pipelineRes = await runPipeline({
      url: currentUrl,
      userAgent,
      browserEndpoint: browserEndpoint || undefined,
      browserApiKey: browserApiKey || undefined,
      stealthEndpoint: stealthEndpoint || undefined,
      stealthApiKey: stealthApiKey || undefined,
      forceStage,
      timeoutMs,
    });

    let extracted: unknown = null;
    let parseError: string | null = null;
    if (pipelineRes.html) {
      try {
        const llmRes = await extractWithLlm({
          html: pipelineRes.html,
          prompt,
          schemaJson,
          endpoint: liaraEndpoint,
          apiKey: liaraApiKey,
          model: liaraModel,
          timeoutMs,
        });
        extracted = llmRes.extracted;
        parseError = llmRes.parseError;
        totIn += llmRes.usage.input;
        totOut += llmRes.usage.output;
        allFromApi = allFromApi && llmRes.usage.fromApi;
        llmCalls += 1;
        llmModel = llmRes.modelUsed;
        llmProvider = llmRes.provider;
        // Fase 3 (#15): prompt (HTML sanitizzato incluso, cappato dal logger)
        // + risposta → StepLog 'llm', una entry-serie per pagina.
        logLlmExchange(context, {
          provider: llmRes.provider,
          model: llmRes.modelUsed,
          system: llmRes.sentSystem,
          user: llmRes.sentUser,
          response: llmRes.rawResponse,
          phase: `pagina ${String(pageNum)}`,
        });
      } catch (err) {
        parseError = String(err);
      }
    } else if (pipelineRes.screenshotBase64) {
      // Visually-only flow: user dovra\` chainare action_vision_extract con questo screenshot
      parseError = 'visually-only content — chain action_vision_extract with screenshotBase64';
    } else {
      parseError = 'no HTML and no screenshot from pipeline';
    }

    pages.push({
      url: currentUrl,
      finalUrl: pipelineRes.finalUrl,
      finalStage: pipelineRes.finalStage,
      extracted,
      parseError,
      pipelineSteps: pipelineRes.steps,
    });

    // Pagination
    if (pageNum >= maxPages) break;
    const next = detectNextPage(pipelineRes.html, pipelineRes.finalUrl);
    if (!next.found || !next.url) break;
    if (next.url === currentUrl) break; // safety: same URL = infinite loop
    if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
    currentUrl = next.url;
  }

  const successfulPages = pages.filter((p) => p.extracted !== null && p.parseError === null).length;

  return {
    output: {
      pages,
      pagesScraped: pages.length,
      pagesSuccessful: successfulPages,
      paginationDetected: pages.length > 1,
      finalStages: pages.map((p) => p.finalStage),
      extracted: pages.length === 1 ? pages[0]?.extracted : pages.map((p) => p.extracted),
      // Fase 2 (#14): usage standard cross-nodo, cumulativo sulle pagine.
      ...(llmCalls > 0
        ? {
            _llm: {
              inputTokens: totIn,
              outputTokens: totOut,
              model: llmModel,
              provider: llmProvider,
              fromApi: allFromApi,
            },
          }
        : {}),
    },
    durationMs: Date.now() - start,
  };
};

export const scrapeSmartNode: NodeModule = {
  def: {
    id: 'action_scrape_smart',
    type: 'action',
    label: 'Scrape Smart (orchestratore AI)',
    icon: 'sparkles',
    color: '#f59e0b',
    description:
      'Orchestratore intelligente di scraping: combina fetch + browser + stealth + vision + LLM extract in UN nodo. Risparmia 5-10 nodi di workflow manuale.\n\n' +
      'Pipeline adaptive 4-stage (heuristic-driven):\n' +
      '  1. fetch_simple → HTML quick\n' +
      '  2. browser_render se HTML scarno (SPA shell)\n' +
      '  3. browser_stealth se anti-bot challenge (Cloudflare/Akamai/DataDome/PerimeterX)\n' +
      '  4. vision_extract se contenuto visually-only (canvas/PDF/SVG)\n\n' +
      'Estrazione: un LLM OpenAI-compatibile (default Liara locale, ma puoi puntarlo a QUALSIASI endpoint /v1/chat/completions via i campi sotto) riceve HTML + prompt naturale ("estrai prezzo, titolo, immagine") + schema JSON target → ritorna oggetto strutturato. No CSS selectors.\n\n' +
      'Pagination: auto-detect rel="next", aria-label "Next", text "Successivo/Avanti/›", URL pattern page=N → page=N+1. Follow fino a maxPages.\n\n' +
      'Observability: ogni request espone pipelineSteps con stage usato + duration + evidence + errore.\n\n' +
      'Setup BYO: configura MEDEA_BROWSER_ENDPOINT + MEDEA_STEALTH_ENDPOINT (browserless self-host o managed Zeli). LLM = qualsiasi endpoint OpenAI-compatibile (default Liara locale :3003); override endpoint/key/model nei campi.\n\n' +
      'Use case: (1) scraping listing prodotti e-commerce con pagination + extract JSON strutturato, (2) ingest dati pubblici (registri/anagrafiche) con fallback adaptive, (3) monitoring concorrenti con AI extract di prezzi e stock, (4) onboarding cliente B2B che chiede "scarica i miei dati da X" senza scrivere CSS selectors.',
    outputContract: {
      notes: 'I dati estratti stanno in `extracted`, con i nomi dello schema in configurazione. `pagesSuccessful` inferiore a `pagesScraped` significa che alcune pagine non hanno dato niente: i dati sono parziali.',
      fields: [
        { name: 'extracted', type: 'object|array', desc: 'I dati estratti, coi nomi dello schema in configurazione.' },
        { name: 'pages', type: 'array', desc: 'Le pagine visitate, con il loro esito.' },
        { name: 'pagesScraped', type: 'number', desc: 'Quante pagine ha aperto.' },
        { name: 'pagesSuccessful', type: 'number', desc: 'Quante hanno dato dei dati.' },
        { name: 'paginationDetected', type: 'boolean', desc: 'Se ha riconosciuto e seguito l\'impaginazione del sito.' },
        { name: 'finalStages', type: 'array', desc: 'Le tecniche usate per arrivare al dato, in ordine.' },
        { name: '_llm', type: 'object', desc: 'Il consumo di token. Presente solo se e` stato interpellato un modello.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL iniziale',
        type: 'text',
        required: true,
        placeholder: 'https://target.com/products',
        help: 'URL da scrappare.',
      },
      {
        key: 'prompt',
        label: 'Cosa estrarre (italiano)',
        type: 'textarea',
        required: true,
        placeholder:
          'Estrai dal listing: per ogni prodotto titolo, prezzo, link, immagine principale, disponibilita\\` stock.',
        help: 'Descrivi i dati in linguaggio naturale.',
      },
      {
        key: 'schemaJson',
        label: 'Schema JSON target (opzionale)',
        type: 'textarea',
        required: false,
        placeholder: '{"products": [{"title": "string", "price": "number", "link": "string"}]}',
        help: 'Shape attesa. Vuoto = oggetto libero.',
      },
      {
        key: 'forceStage',
        label: 'Forza stage',
        type: 'select',
        required: false,
        defaultValue: 'auto',
        options: ['auto', 'fetch_simple', 'browser_render', 'browser_stealth', 'vision_extract'],
        help: 'auto = pipeline upgrade adaptive (RACCOMANDATO). fetch_simple = solo HTTP GET. browser_render = headless per SPA. browser_stealth = anti-bot enterprise. vision_extract = canvas/PDF visually-only.',
      },
      {
        key: 'maxPages',
        label: 'Max pages (pagination)',
        type: 'number',
        required: false,
        defaultValue: '1',
        help: 'Pagine totali da seguire via pagination auto-detect. Default 1 (no pagination).',
      },
      {
        key: 'pageDelayMs',
        label: 'Delay tra pagine (ms)',
        type: 'number',
        required: false,
        defaultValue: '1000',
        help: 'Pausa human-like tra page fetch. Default 1s.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout per stage (ms)',
        type: 'number',
        required: false,
        defaultValue: '30000',
        help: 'Max per ogni stage. Default 30s. Max 120s.',
      },
      {
        key: 'userAgent',
        label: 'User-Agent (fetch_simple)',
        type: 'text',
        required: false,
        defaultValue: 'FlowForge-SmartScrape/1.0',
        help: 'UA per fetch HTTP plain. Browser usano fingerprint propri.',
      },
      {
        key: 'browserEndpoint',
        label: 'Browser endpoint (BYO)',
        type: 'text',
        required: false,
        placeholder: 'env MEDEA_BROWSER_ENDPOINT',
        help: 'Server Playwright. Vuoto = no upgrade a stage 2.',
      },
      {
        key: 'browserApiKey',
        label: 'Browser API key',
        type: 'secret',
        required: false,
        help: 'Bearer browser endpoint.',
      },
      {
        key: 'stealthEndpoint',
        label: 'Stealth endpoint (BYO)',
        type: 'text',
        required: false,
        placeholder: 'env MEDEA_STEALTH_ENDPOINT',
        help: 'Server stealth (puppeteer-extra). Vuoto = no upgrade a stage 3.',
      },
      {
        key: 'stealthApiKey',
        label: 'Stealth API key',
        type: 'secret',
        required: false,
        help: 'Bearer stealth endpoint.',
      },
      {
        key: 'liaraEndpoint',
        label: 'LLM endpoint (OpenAI-compat, override)',
        type: 'text',
        required: false,
        help: 'Vuoto = Liara via gateway FlowForge (default, metered sulla quota). Compila SOLO per un provider OpenAI-compatibile tuo (OpenAI, Groq, OpenRouter, vLLM, Ollama…).',
      },
      {
        key: 'liaraApiKey',
        label: 'LLM API key (Bearer, override)',
        type: 'secret',
        required: false,
        help: "Bearer token dell'endpoint custom. Vuoto = license del workspace (gateway Liara).",
      },
      {
        key: 'liaraModel',
        label: 'LLM model (override)',
        type: 'text',
        required: false,
        help: 'Vuoto = modello di default del gateway Liara. Per provider custom usa il loro model ID (es. gpt-4o-mini, llama-3.1-70b).',
      },
    ],
    outputs: [
      'extracted',
      'pages',
      'pagesScraped',
      'pagesSuccessful',
      'paginationDetected',
      'finalStages',
    ],
  },
  executor,
};
