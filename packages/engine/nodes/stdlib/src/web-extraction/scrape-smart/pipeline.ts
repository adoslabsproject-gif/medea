/**
 * Pipeline orchestratore scrape-smart — adaptive multi-stage.
 *
 * Stages:
 *  1. fetch_simple  — cheap GET con safeFetch
 *  2. browser_render — se HTML scarno (heuristic detectThinHtml)
 *  3. browser_stealth — se anti-bot challenge (heuristic detectAntiBot)
 *  4. vision_extract — se contenuto visually-only (heuristic detectVisuallyOnly)
 *
 * Ogni stage upgrade aggiunge cost/latenza. La pipeline si ferma al primo
 * stage che produce HTML estraibile.
 */

import { safeFetchWithRedirects } from '@medea/engine-safe-fetch';
import { detectThinHtml, detectAntiBot, detectVisuallyOnly } from './heuristics.js';

export type PipelineStage = 'fetch_simple' | 'browser_render' | 'browser_stealth' | 'vision_extract';

export interface PipelineStepLog {
  stage: PipelineStage;
  status: 'success' | 'skipped' | 'failed';
  durationMs: number;
  evidence?: string;
  error?: string;
}

export interface PipelineResult {
  finalStage: PipelineStage;
  html: string;
  screenshotBase64: string | null;
  finalUrl: string;
  statusCode: number | null;
  steps: PipelineStepLog[];
  needsVision: boolean;
  visionReason: string;
}

export interface PipelineConfig {
  url: string;
  userAgent: string;
  browserEndpoint: string | undefined;
  browserApiKey: string | undefined;
  stealthEndpoint: string | undefined;
  stealthApiKey: string | undefined;
  forceStage: PipelineStage | undefined;
  skipUpgrade?: boolean;
  timeoutMs: number;
}

interface BrowserResp { html?: string; cookies?: string[]; finalUrl?: string; screenshotBase64?: string }

async function fetchSimple(cfg: PipelineConfig): Promise<{ html: string; status: number; finalUrl: string }> {
  const res = await safeFetchWithRedirects(cfg.url, {
    method: 'GET',
    headers: { 'User-Agent': cfg.userAgent, Accept: 'text/html,*/*' },
    timeoutMs: cfg.timeoutMs,
  });
  const html = await res.text();
  return { html, status: res.status, finalUrl: res.url || cfg.url };
}

async function callBrowser(endpoint: string, apiKey: string, url: string, screenshot: boolean, timeoutMs: number): Promise<BrowserResp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/render`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, screenshot, viewport: { width: 1280, height: 800 }, waitTimeoutMs: timeoutMs }),
    timeoutMs: timeoutMs + 5000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`browser ${res.status.toString()}: ${t.slice(0, 200)}`);
  }
  return await res.json() as BrowserResp;
}

async function callStealth(endpoint: string, apiKey: string, url: string, screenshot: boolean, timeoutMs: number): Promise<BrowserResp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await safeFetchWithRedirects(`${endpoint.replace(/\/$/, '')}/stealth-render`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url,
      fingerprint: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', viewport: { width: 1920, height: 1080 }, locale: 'it-IT', timezone: 'Europe/Rome' },
      humanLike: true,
      screenshot: screenshot ? { fullPage: false } : undefined,
      waitTimeoutMs: timeoutMs,
    }),
    timeoutMs: timeoutMs + 10_000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`stealth ${res.status.toString()}: ${t.slice(0, 200)}`);
  }
  return await res.json() as BrowserResp;
}

export async function runPipeline(cfg: PipelineConfig): Promise<PipelineResult> {
  const steps: PipelineStepLog[] = [];
  let html = '';
  let statusCode: number | null = null;
  let finalUrl = cfg.url;
  let screenshotBase64: string | null = null;

  // Stage 1: fetch_simple
  if (cfg.forceStage && cfg.forceStage !== 'fetch_simple') {
    steps.push({ stage: 'fetch_simple', status: 'skipped', durationMs: 0, evidence: `forceStage=${cfg.forceStage}` });
  } else {
    const t0 = Date.now();
    try {
      const r = await fetchSimple(cfg);
      html = r.html; statusCode = r.status; finalUrl = r.finalUrl;
      steps.push({ stage: 'fetch_simple', status: 'success', durationMs: Date.now() - t0 });
    } catch (err) {
      steps.push({ stage: 'fetch_simple', status: 'failed', durationMs: Date.now() - t0, error: String(err) });
    }
  }

  if (cfg.skipUpgrade && html) {
    const vis = detectVisuallyOnly(html);
    return { finalStage: 'fetch_simple', html, screenshotBase64: null, finalUrl, statusCode, steps, needsVision: vis.needsVision, visionReason: vis.reason };
  }

  // Stage 2: browser_render se HTML scarno
  const thin = detectThinHtml(html);
  const antiBot = detectAntiBot(html, statusCode ?? undefined);

  let finalStage: PipelineStage = 'fetch_simple';

  // forceStage='fetch_simple' o skipUpgrade → blocca tutti gli upgrade.
  // forceStage='browser_render'/'browser_stealth'/'vision_extract' → forza
  //   specifico stage (saltando heuristics).
  // forceStage undefined o non riconosciuto → adaptive (default).
  const adaptive = cfg.forceStage === undefined;
  const stopAtFetch = cfg.forceStage === 'fetch_simple';

  const shouldRender = !stopAtFetch && (cfg.forceStage === 'browser_render' || (adaptive && thin.isThin && !antiBot.isChallenged));
  if (shouldRender) {
    if (!cfg.browserEndpoint) {
      steps.push({ stage: 'browser_render', status: 'skipped', durationMs: 0, error: 'no browserEndpoint configured' });
    } else {
      const t0 = Date.now();
      try {
        const r = await callBrowser(cfg.browserEndpoint, cfg.browserApiKey ?? '', cfg.url, false, cfg.timeoutMs);
        html = r.html ?? html; finalUrl = r.finalUrl ?? finalUrl;
        finalStage = 'browser_render';
        steps.push({ stage: 'browser_render', status: 'success', durationMs: Date.now() - t0, evidence: `thin: ${thin.bodyContentLength.toString()}b` });
      } catch (err) {
        steps.push({ stage: 'browser_render', status: 'failed', durationMs: Date.now() - t0, error: String(err) });
      }
    }
  }

  // Stage 3: browser_stealth se anti-bot challenge (ricontrolla dopo eventual browser_render)
  const antiBot2 = detectAntiBot(html, statusCode ?? undefined);
  const stopBeforeStealth = stopAtFetch || cfg.forceStage === 'browser_render';
  const shouldStealth = !stopBeforeStealth && (cfg.forceStage === 'browser_stealth' || cfg.forceStage === 'vision_extract' || (adaptive && antiBot2.isChallenged));
  if (shouldStealth) {
    if (!cfg.stealthEndpoint) {
      steps.push({ stage: 'browser_stealth', status: 'skipped', durationMs: 0, error: 'no stealthEndpoint configured' });
    } else {
      const t0 = Date.now();
      try {
        const wantScreenshot = cfg.forceStage === 'vision_extract' || detectVisuallyOnly(html).needsVision;
        const r = await callStealth(cfg.stealthEndpoint, cfg.stealthApiKey ?? '', cfg.url, wantScreenshot, cfg.timeoutMs);
        html = r.html ?? html; finalUrl = r.finalUrl ?? finalUrl;
        screenshotBase64 = r.screenshotBase64 ?? null;
        finalStage = 'browser_stealth';
        steps.push({ stage: 'browser_stealth', status: 'success', durationMs: Date.now() - t0, evidence: antiBot2.vendor ?? 'forced' });
      } catch (err) {
        steps.push({ stage: 'browser_stealth', status: 'failed', durationMs: Date.now() - t0, error: String(err) });
      }
    }
  }

  // Stage 4 marker: visually-only (NON eseguito qui, downstream node action_vision_extract lo gestisce)
  const vis = detectVisuallyOnly(html);
  if (vis.needsVision && !screenshotBase64 && cfg.stealthEndpoint) {
    // Grab screenshot via stealth se non gia\` fatto
    const t0 = Date.now();
    try {
      const r = await callStealth(cfg.stealthEndpoint, cfg.stealthApiKey ?? '', cfg.url, true, cfg.timeoutMs);
      screenshotBase64 = r.screenshotBase64 ?? null;
      finalStage = 'vision_extract';
      steps.push({ stage: 'vision_extract', status: 'success', durationMs: Date.now() - t0, evidence: vis.reason });
    } catch (err) {
      steps.push({ stage: 'vision_extract', status: 'failed', durationMs: Date.now() - t0, error: String(err) });
    }
  }

  return { finalStage, html, screenshotBase64, finalUrl, statusCode, steps, needsVision: vis.needsVision, visionReason: vis.reason };
}
