/**
 * action_cloudflare_solver — solve Cloudflare JS challenge via FlareSolverr.
 *
 * FlareSolverr (https://github.com/FlareSolverr/FlareSolverr) e\` un proxy
 * open-source che risolve Cloudflare/DDoS-Guard/UAM challenge usando un
 * browser headless. Il tenant lo self-hosta (docker container leggero) e
 * configura l'endpoint qui.
 *
 * Pattern: il nodo POST /v1 a FlareSolverr con { cmd: 'request.get', url }
 * → riceve back { solution: { cookies: [...], userAgent, response: html } }
 * → ritorna `cf_clearance` cookie + UA da riusare nei fetch successivi.
 *
 * NON include FlareSolverr server in stdlib (bring-your-own).
 *
 * Use case LEGITTIMI:
 *  - Test del PROPRIO sito protetto da Cloudflare
 *  - Monitoraggio uptime sito aziendale con CF challenge attivo
 *  - Integrazione con partner B2B che hanno CF
 * NON usare per: evadere CF di terzi senza autorizzazione (TOS violation).
 */

import { safeFetchWithRedirects, assertUrlSafe } from '@medea/engine-safe-fetch';
import type { NodeModule, NodeExecutor } from '../types.js';

interface FlareSolverrResponse {
  status?: string;
  message?: string;
  solution?: {
    url?: string;
    status?: number;
    cookies?: { name: string; value: string; domain?: string }[];
    userAgent?: string;
    response?: string;
  };
}

const executor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const url = String(config.url ?? '');
  if (!url) throw new Error('url required');
  // SSRF-by-proxy (#2): valida la PAGINA navigata dal solver BYO (coerente con
  // browser-automate) — IP privato/interno via il servizio solver altrimenti.
  assertUrlSafe(url);

  const endpoint = String(config.endpoint ?? process.env.MEDEA_FLARESOLVERR_ENDPOINT ?? '').trim();
  if (!endpoint) {
    throw new Error(
      'FlareSolverr endpoint not configured. Set MEDEA_FLARESOLVERR_ENDPOINT env or fill "endpoint" config. Self-host: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest',
    );
  }

  const sessionId = String(config.sessionId ?? '').trim();
  const cmd = String(config.cmd ?? 'request.get');
  const maxTimeoutMs = Math.max(10_000, Math.min(Number(config.maxTimeoutMs ?? 60_000), 180_000));

  const reqBody: Record<string, unknown> = {
    cmd,
    url,
    maxTimeout: maxTimeoutMs,
  };
  if (sessionId) reqBody.session = sessionId;

  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
    timeoutMs: maxTimeoutMs + 10_000,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`FlareSolverr ${res.status.toString()}: ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as FlareSolverrResponse;
  if (data.status !== 'ok' || !data.solution) {
    throw new Error(`FlareSolverr failed: ${data.message ?? 'unknown error'}`);
  }

  // Build cookie header string (cookie=value; cookie2=value2)
  const cookieStr = (data.solution.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
  const cfClearance = (data.solution.cookies ?? []).find((c) => c.name === 'cf_clearance');

  return {
    output: {
      cookies: data.solution.cookies ?? [],
      cookieHeader: cookieStr,
      cfClearance: cfClearance?.value ?? null,
      userAgent: data.solution.userAgent ?? null,
      html: data.solution.response ?? '',
      finalUrl: data.solution.url ?? url,
      sessionId: sessionId || null,
    },
    durationMs: Date.now() - start,
  };
};

export const cloudflareSolverNode: NodeModule = {
  def: {
    id: 'action_cloudflare_solver',
    type: 'action',
    label: 'Cloudflare Solver',
    icon: 'shield',
    color: '#f97316',
    description:
      'Risolve Cloudflare/DDoS-Guard JavaScript challenge via FlareSolverr (https://github.com/FlareSolverr/FlareSolverr). Ritorna il cookie `cf_clearance` + User-Agent da usare nei fetch successivi al sito Cloudflare-protected.\n\n' +
      "Setup: il tenant self-hosta FlareSolverr (1 docker container leggero) e configura qui l'endpoint. Bring Your Own — Zeli non gestisce solver pubblici per evitare abusi.\n\n" +
      'USA SOLO per: accesso a PROPRI siti protetti da CF, monitoraggio uptime, integrazione partner B2B. NON usare per: evasione paywall/protezione siti di terzi (TOS violation, potenziale liability legale del tenant).\n\n' +
      'Workflow tipico: 1) cloudflare_solver(url) → cookies+UA, 2) web_fetch_advanced(url, cookies=output.cookieHeader, UA=output.userAgent) → HTML reale.\n\n' +
      'Use case: (1) monitoraggio uptime di propria pagina dietro CF, (2) audit periodico content proprio sito Cloudflare-protected, (3) integrazione partner B2B che usa CF managed challenge, (4) scraping pricing pages proprie multi-region.',
    outputContract: {
      notes: 'Serve a ottenere i cookie con cui le richieste successive passano il filtro: `cookieHeader` e `userAgent` vanno rimessi INSIEME nelle chiamate a valle — cambiare l\'agente invalida il cookie.',
      fields: [
        { name: 'cookies', type: 'array', desc: 'I cookie ottenuti, uno per elemento.' },
        { name: 'cookieHeader', type: 'string', desc: 'Gli stessi cookie gia` pronti da mettere nell\'header di una richiesta.' },
        { name: 'cfClearance', type: 'string', desc: 'Il cookie che vale come lasciapassare.' },
        { name: 'userAgent', type: 'string', desc: 'L\'agente usato: va tenuto identico nelle chiamate successive.' },
        { name: 'html', type: 'string', desc: 'L\'HTML della pagina una volta superato il filtro.' },
        { name: 'finalUrl', type: 'string', desc: 'Dove e` arrivato.' },
        { name: 'sessionId', type: 'string', desc: 'La sessione, per riusare lo stesso lasciapassare.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
    configFields: [
      {
        key: 'url',
        label: 'URL Cloudflare-protected',
        type: 'text',
        required: true,
        placeholder: 'https://miosito.com',
        help: 'URL del sito protetto da Cloudflare. Il solver fa GET e risolve il challenge JS.',
      },
      {
        key: 'endpoint',
        label: 'FlareSolverr endpoint',
        type: 'text',
        required: false,
        placeholder: 'http://flaresolverr.local:8191 (vuoto = env MEDEA_FLARESOLVERR_ENDPOINT)',
        help: 'URL del tuo FlareSolverr. Default container Docker: http://localhost:8191. Self-host: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest',
      },
      {
        key: 'cmd',
        label: 'Comando',
        type: 'select',
        required: false,
        options: ['request.get', 'request.post', 'sessions.create', 'sessions.destroy'],
        defaultValue: 'request.get',
        help: 'request.get = solve + GET URL. request.post = solve + POST. sessions.* = gestione persistent session (riduce solve time su request successive).',
      },
      {
        key: 'sessionId',
        label: 'Session ID (opzionale)',
        type: 'text',
        required: false,
        placeholder: 'my-tenant-session-1',
        help: "Riusa una session FlareSolverr esistente. Crea prima con cmd=sessions.create, poi riusa l'ID per skipare il solve ad ogni request. Auto-expire dopo idle.",
      },
      {
        key: 'maxTimeoutMs',
        label: 'Timeout solve (ms)',
        type: 'number',
        required: false,
        defaultValue: '60000',
        help: 'Tempo max che FlareSolverr ha per risolvere. Default 60s. Min 10s, max 180s.',
      },
    ],
    outputs: [
      'cookies',
      'cookieHeader',
      'cfClearance',
      'userAgent',
      'html',
      'finalUrl',
      'sessionId',
    ],
  },
  executor,
};
