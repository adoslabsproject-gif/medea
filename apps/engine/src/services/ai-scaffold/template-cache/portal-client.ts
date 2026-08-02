/**
 * Portal Client per Shared Workflow Templates (Livello 2 community).
 *
 * Container tenant → Portal: promote + retrieve + import-record + unshare.
 * Auth: X-Internal-Token (MEDEA_INTERNAL_TOKEN env).
 *
 * Best-effort: tutte le funzioni catch + return null/false su errore.
 * Il template cache locale (Livello 1) continua a funzionare anche se
 * il portal e\` down/lento — degradation graceful.
 */

import { logger } from '@/lib/logger.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';

const PORTAL_URL = process.env.MEDEA_PORTAL_URL ?? 'http://172.20.0.1:3006';
// tenant→portal usa lo shared token outbound (PORTAL_CALLBACK_TOKEN, = portal
// global secret; fallback MEDEA_INTERNAL_TOKEN per container vecchi).
const INTERNAL_TOKEN = getOutboundPortalToken();
const TIMEOUT_MS = 5_000;

interface PromoteRequest {
  name: string;
  description?: string;
  language: 'it' | 'en' | 'es' | 'fr' | 'de' | 'pt';
  graphSignature: string;
  graphDefIds: string[];
  workflowJson: Record<string, unknown>;
  promptText: string;
  promptTokens: string[];
  /** Base64-encoded BGE-M3 buffer (1024 * 4 = 4096 byte) */
  promptEmbedding?: string;
  sourceWorkspaceId: string;
}

interface PromoteResponse {
  ok: boolean;
  id: string;
  isNew: boolean;
}

export interface CommunityTemplate {
  id: string;
  name: string;
  description: string | null;
  language: string;
  graphSignature: string;
  graphDefIds: string[];
  workflowJson: unknown;
  promptText: string;
  promptTokens: string[];
  promptEmbedding: string | null; // base64
  importedCount: number;
  successCount: number;
  failCount: number;
  promotedAt: string;
}

async function portalFetch<T>(path: string, body: unknown): Promise<T | null> {
  if (!INTERNAL_TOKEN) {
    logger.warn('[templates-portal] MEDEA_INTERNAL_TOKEN not set — community templates disabled');
    return null;
  }
  try {
    const res = await fetch(`${PORTAL_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': INTERNAL_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = (await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text;
      logger.warn(
        { status: res.status, path, body: text.slice(0, 300) },
        '[templates-portal] non-2xx',
      );
      return null;
    }
    return await readJsonCapped<T>(res);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      '[templates-portal] fetch failed (graceful degrade)',
    );
    return null;
  }
}

export async function promoteToCommunity(req: PromoteRequest): Promise<PromoteResponse | null> {
  return portalFetch<PromoteResponse>('/api/v1/internal/templates/promote', req);
}

export async function retrieveFromCommunity(req: {
  language?: 'it' | 'en' | 'es' | 'fr' | 'de' | 'pt';
  queryTokens?: string[];
  requiredDefIds?: string[];
  limit?: number;
}): Promise<{ ok: boolean; templates: CommunityTemplate[]; count: number } | null> {
  return portalFetch('/api/v1/internal/templates/retrieve', req);
}

export async function recordCommunityImport(templateId: string): Promise<boolean> {
  const r = await portalFetch<{ ok: boolean }>('/api/v1/internal/templates/import', { templateId });
  return r?.ok ?? false;
}

export async function unshareFromCommunity(opts: {
  templateId: string;
  sourceWorkspaceId: string;
  reason?: string;
}): Promise<boolean> {
  const r = await portalFetch<{ ok: boolean }>('/api/v1/internal/templates/unshare', opts);
  return r?.ok ?? false;
}
