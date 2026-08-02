/**
 * action_browser_automate — automazione browser INTERATTIVA multi-step su un
 * endpoint Playwright BYO (Bring Your Own Browser), nello stesso pattern di
 * browser-render/stealth-browser: NESSUN Chromium nel container (zero +300MB),
 * il nodo chiama un endpoint esterno configurabile (browserless self-host o
 * managed Zeli) via MEDEA_BROWSER_ENDPOINT.
 *
 * Differenza vs gli altri nodi browser (render/scrape one-shot): qui esegui una
 * SEQUENZA di passi in UNA sessione — goto → wait → click → type → extract →
 * screenshot — per flussi che richiedono interazione (login form, filtri,
 * paginazione, wizard). Rimpiazza il vecchio browser-nav-tools.service.ts
 * (Playwright LOCALE, orfano + mai installato) con l'architettura corretta.
 *
 * SSRF: ogni URL navigato (startUrl + ogni `goto`) è validato con assertUrlSafe
 * (@medea/engine-safe-fetch) → blocca IP privati/loopback/link-local (cloud
 * metadata 169.254.169.254) — stesse difese degli altri nodi web. La chiamata
 * all'endpoint BYO passa per safeFetchWithRedirects.
 */
import { assertUrlSafe, safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

const MAX_STEPS = 50;
const STEP_ACTIONS = new Set(['goto', 'click', 'type', 'waitFor', 'extract', 'screenshot']);

interface AutomateStep {
  action: string;
  selector?: string;
  text?: string;
  url?: string;
  name?: string;
}

function parseSteps(raw: unknown): AutomateStep[] {
  let arr: unknown = raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try { arr = JSON.parse(raw); } catch { throw new Error('action_browser_automate: "steps" non è JSON valido'); }
  }
  if (!Array.isArray(arr)) throw new Error('action_browser_automate: "steps" deve essere un array');
  if (arr.length === 0) throw new Error('action_browser_automate: almeno uno step richiesto');
  if (arr.length > MAX_STEPS) throw new Error(`action_browser_automate: troppi step (max ${MAX_STEPS.toString()})`);
  return arr.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`action_browser_automate: step ${i.toString()} non valido`);
    const step = s as AutomateStep;
    if (!STEP_ACTIONS.has(step.action)) throw new Error(`action_browser_automate: azione sconosciuta "${step.action}" allo step ${i.toString()}`);
    return step;
  });
}

const browserAutomateExecutor: NodeExecutor = async (config, _input, _ctx) => {
  const startedAt = Date.now();

  const endpoint = String(config.endpoint ?? process.env.MEDEA_BROWSER_ENDPOINT ?? '').trim();
  if (!endpoint) {
    throw new Error('action_browser_automate: endpoint non configurato. Imposta MEDEA_BROWSER_ENDPOINT o il campo "endpoint" (BYO: browserless self-host o endpoint Zeli managed).');
  }
  const startUrl = String(config.startUrl ?? '').trim();
  if (!startUrl) throw new Error('action_browser_automate: startUrl richiesto');

  // SSRF: valida l'URL iniziale e ogni navigazione `goto` (attacker/AI-controlled).
  assertUrlSafe(startUrl);
  const steps = parseSteps(config.steps);
  for (const s of steps) {
    if (s.action === 'goto' && s.url) assertUrlSafe(s.url);
  }

  const apiKey = String(config.apiKey ?? '').trim();
  const timeoutMs = Math.max(2000, Math.min(Number(config.timeoutMs ?? 30_000), 120_000));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/automate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ startUrl, steps, timeoutMs }),
    timeoutMs: timeoutMs + 5000,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`action_browser_automate: endpoint browser ha risposto ${res.status.toString()} ${errText.slice(0, 300)}`);
  }
  const data = await res.json() as {
    extracted?: Record<string, unknown>;
    finalUrl?: string;
    screenshots?: string[];
    stepsRun?: number;
    error?: string;
  };
  if (data.error) throw new Error(`action_browser_automate: ${data.error}`);

  return {
    output: {
      extracted: data.extracted ?? {},
      finalUrl: data.finalUrl ?? startUrl,
      screenshots: data.screenshots ?? [],
      stepsRun: typeof data.stepsRun === 'number' ? data.stepsRun : steps.length,
    },
    durationMs: Date.now() - startedAt,
  };
};

export const browserAutomateNode: NodeModule = {
  def: {
    id: 'action_browser_automate',
    type: 'action',
    label: 'Browser: Automazione',
    icon: 'mouse-pointer-click',
    color: '#7c3aed',
    description:
      'Automazione browser INTERATTIVA multi-step su un endpoint Playwright BYO (Bring Your Own Browser) — la ' +
      'navigazione stateful che mancava: a differenza di "Browser Render" e "Scrape Smart" (one-shot), qui esegui ' +
      'una SEQUENZA di passi nella stessa sessione del browser, per i flussi che richiedono interazione reale. ' +
      'Passi disponibili (campo steps, array JSON): goto (naviga a un URL), waitFor (attende un selettore CSS), ' +
      'click (clicca un elemento), type (digita in un input), extract (estrae testo da un selettore, salvato col ' +
      'nome che scegli), screenshot (cattura la viewport). Architettura identica agli altri nodi browser: NESSUN ' +
      'Chromium nel container (zero +300MB) — il nodo chiama un endpoint esterno configurabile ' +
      '(MEDEA_BROWSER_ENDPOINT: browserless self-host o endpoint Zeli managed). Difese SSRF integrate: ogni ' +
      'URL navigato (iniziale + ogni goto) è validato (blocco di IP privati, loopback, link-local/metadata cloud) ' +
      'con le stesse protezioni degli altri nodi web; la chiamata all\'endpoint passa per safe-fetch. Cap di ' +
      'sicurezza: max 50 passi, timeout 2-120s. ' +
      'Output: { extracted, finalUrl, screenshots, stepsRun }. ' +
      'Use case: login su un portale e scaricare un report dietro autenticazione (type credenziali → click → ' +
      'extract); compilare e inviare un form multi-campo; navigare la paginazione di un catalogo estraendo i dati ' +
      'a ogni pagina; attendere il caricamento dinamico (waitFor) prima di estrarre contenuti renderizzati da JS.',
    configFields: [
      {
        key: 'startUrl', label: 'URL iniziale', type: 'expression', required: true,
        placeholder: 'https://portale.esempio.it/login',
        help: 'La pagina da cui parte la sessione. Validata anti-SSRF (no IP interni).',
      },
      {
        key: 'steps', label: 'Passi (JSON)', type: 'json', required: true,
        placeholder: '[\n  { "action": "waitFor", "selector": "#user" },\n  { "action": "type", "selector": "#user", "text": "{{ $secrets.PORTAL_USER }}" },\n  { "action": "type", "selector": "#pass", "text": "{{ $secrets.PORTAL_PASS }}" },\n  { "action": "click", "selector": "button[type=submit]" },\n  { "action": "extract", "selector": ".report-total", "name": "totale" }\n]',
        help: 'Sequenza di passi: goto/waitFor/click/type/extract/screenshot. Max 50.',
      },
      {
        key: 'endpoint', label: 'Endpoint browser (BYO)', type: 'text', required: false,
        placeholder: 'vuoto = env MEDEA_BROWSER_ENDPOINT',
        help: 'Server Playwright esterno (browserless self-host o endpoint Zeli managed). Vuoto = usa env.',
      },
      {
        key: 'apiKey', label: 'API key endpoint', type: 'secret', required: false,
        help: 'Token Bearer per l\'endpoint browser, se richiesto.',
      },
      {
        key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false, defaultValue: '30000',
        help: 'Tempo massimo dell\'intera sessione (2.000-120.000 ms).',
      },
    ],
    outputs: ['default'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
  executor: browserAutomateExecutor,
};
