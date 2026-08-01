/**
 * GitHub integration executor — REST API v3 (issues/PRs/commits).
 *
 * Credentials: { token: "ghp_..." | "github_pat_..." }
 *
 * @module executors/integrations/github
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const GH_API = 'https://api.github.com';

interface GhCredentials { token: string }

interface FetchOpts { method?: string; body?: unknown; signal?: AbortSignal | undefined }

async function ghFetch<T>(token: string, path: string, opts: FetchOpts = {}): Promise<{ data: T; rateLimit: number | null }> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'FlowForge-Integrations/1.0',
    },
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await safeOutboundFetch(`${GH_API}${path}`, init);
  const rateLimit = Number(res.headers.get('x-ratelimit-remaining'));
  if (!res.ok) {
    let errMsg = `GitHub HTTP ${String(res.status)} ${res.statusText}`;
    try {
      const errBody = await readJsonCapped<{ message?: string }>(res);
      if (errBody.message) errMsg += `: ${errBody.message}`;
    } catch { /* body not JSON */ }
    throw new IntegrationError({
      provider: 'github', code: 'API_HTTP_ERROR', message: errMsg,
      httpStatus: res.status, retryable: res.status >= 500 || res.status === 429 || res.status === 403,
    });
  }
  const data = await readJsonCapped<T>(res);
  return { data, rateLimit: Number.isFinite(rateLimit) ? rateLimit : null };
}

function getStr(cfg: Record<string, unknown>, key: string, required = false): string {
  const v = coerceString(cfg[key] ?? '').trim();
  if (required && !v) throw new IntegrationError({
    provider: 'github', code: 'INVALID_PAYLOAD',
    message: `community_github: "${key}" obbligatorio`,
  });
  return v;
}

export const githubExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = getStr(cfg, 'operation', true);
  const owner = getStr(cfg, 'owner', true);
  const repo = getStr(cfg, 'repo', true);
  // owner/repo finiscono nel PATH dell'URL → encode per evitare path-injection
  // (un `repo = '../../user/keys'` o con `?`/`#` cambierebbe l'endpoint colpito).
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);

  const integration = requireIntegration({
    provider: 'github', tenantId: context.tenantId,
    label: typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null,
  });
  const creds = integration.credentials as unknown as GhCredentials;
  if (!creds.token || (!creds.token.startsWith('ghp_') && !creds.token.startsWith('github_pat_'))) {
    throw new IntegrationError({
      provider: 'github', code: 'INVALID_CREDENTIALS',
      message: 'community_github: token non valido (formato ghp_* o github_pat_*)',
    });
  }

  let data: unknown;
  let count = 0;
  let rateLimit: number | null = null;

  await withRetry(async () => {
    switch (operation) {
      case 'createIssue': {
        const title = getStr(cfg, 'title', true);
        const body: Record<string, unknown> = { title };
        const bodyText = getStr(cfg, 'body');
        if (bodyText) body.body = bodyText;
        const labels = getStr(cfg, 'labels');
        if (labels) body.labels = labels.split(',').map(s => s.trim()).filter(Boolean);
        const assignees = getStr(cfg, 'assignees');
        if (assignees) body.assignees = assignees.split(',').map(s => s.trim()).filter(Boolean);
        const r = await ghFetch<Record<string, unknown>>(creds.token, `/repos/${ownerEnc}/${repoEnc}/issues`, {
          method: 'POST', body, signal: context.abortSignal,
        });
        data = r.data; rateLimit = r.rateLimit;
        break;
      }
      case 'listIssues': {
        const state = getStr(cfg, 'state') || 'open';
        const perPage = Math.min(Math.max(Number(cfg.perPage ?? 30), 1), 100);
        const r = await ghFetch<unknown[]>(creds.token, `/repos/${ownerEnc}/${repoEnc}/issues?state=${encodeURIComponent(state)}&per_page=${perPage.toString()}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r.data; count = r.data.length; rateLimit = r.rateLimit;
        break;
      }
      case 'getIssue': {
        const issueNumber = getStr(cfg, 'issueNumber', true);
        const r = await ghFetch<Record<string, unknown>>(creds.token, `/repos/${ownerEnc}/${repoEnc}/issues/${encodeURIComponent(issueNumber)}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r.data; rateLimit = r.rateLimit;
        break;
      }
      case 'closeIssue': {
        const issueNumber = getStr(cfg, 'issueNumber', true);
        const r = await ghFetch<Record<string, unknown>>(creds.token, `/repos/${ownerEnc}/${repoEnc}/issues/${encodeURIComponent(issueNumber)}`, {
          method: 'PATCH', body: { state: 'closed' }, signal: context.abortSignal,
        });
        data = r.data; rateLimit = r.rateLimit;
        break;
      }
      case 'addComment': {
        const issueNumber = getStr(cfg, 'issueNumber', true);
        const body = getStr(cfg, 'body', true);
        const r = await ghFetch<Record<string, unknown>>(creds.token, `/repos/${ownerEnc}/${repoEnc}/issues/${encodeURIComponent(issueNumber)}/comments`, {
          method: 'POST', body: { body }, signal: context.abortSignal,
        });
        data = r.data; rateLimit = r.rateLimit;
        break;
      }
      case 'createPullRequest': {
        const title = getStr(cfg, 'title', true);
        const head = getStr(cfg, 'headBranch', true);
        const base = getStr(cfg, 'baseBranch') || 'main';
        const bodyText = getStr(cfg, 'body');
        const r = await ghFetch<Record<string, unknown>>(creds.token, `/repos/${ownerEnc}/${repoEnc}/pulls`, {
          method: 'POST',
          body: { title, head, base, ...(bodyText ? { body: bodyText } : {}) },
          signal: context.abortSignal,
        });
        data = r.data; rateLimit = r.rateLimit;
        break;
      }
      case 'listCommits': {
        const perPage = Math.min(Math.max(Number(cfg.perPage ?? 30), 1), 100);
        const r = await ghFetch<unknown[]>(creds.token, `/repos/${ownerEnc}/${repoEnc}/commits?per_page=${perPage.toString()}`, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
        data = r.data; count = r.data.length; rateLimit = r.rateLimit;
        break;
      }
      default:
        throw new IntegrationError({
          provider: 'github', code: 'INVALID_PAYLOAD',
          message: `community_github: operation "${operation}" non supportata`,
        });
    }
  }, { label: `github.${operation}` });

  return {
    output: { ok: true, data, count, rateLimitRemaining: rateLimit },
    durationMs: Date.now() - start,
  };
};
