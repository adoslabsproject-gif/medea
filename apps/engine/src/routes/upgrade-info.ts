/**
 * GET /api/v1/upgrade-info — proxy verso portal /runtime/status per
 * il workspace corrente, esposto all'editor SPA per il banner upgrade.
 *
 * Cache 5 min in-memory per evitare hammer su portal.
 * Auth: stesso pattern del resto (cookie session via authMiddleware esterno).
 */

import { Hono } from 'hono';
import { loggerFor } from '../lib/logger.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import type { Context } from 'hono';
import { getOutboundPortalToken } from '../lib/internal-token.js';

const log = loggerFor('routes.upgrade-info');

interface UpgradeInfoCacheEntry {
  data: UpgradeInfoResponse;
  fetchedAt: number;
}

export interface UpgradeInfoResponse {
  workspaceId: string;
  currentVersion: string | null;
  upgradeAvailable: boolean;
  /** TRUE se è in corso un upgrade del container (graceful overlay UI). */
  upgradeInProgress: boolean;
  /** Timestamp ISO dell'upgrade più recente completato (per auto-reload editor). */
  lastUpgradeAt: string | null;
  pendingUpgrade: null | {
    latestVersion: string;
    releasedAt: string;
    releaseNotesMd: string;
    newNodes: string[];
    breakingChanges: string[];
    securitySeverity: 'low' | 'medium' | 'high' | 'critical' | null;
    isRequired: boolean;
  };
  portalManageUrl: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: UpgradeInfoCacheEntry | null = null;

async function fetchFromPortal(workspaceId: string): Promise<UpgradeInfoResponse> {
  const portalUrl = (process.env.MEDEA_PORTAL_URL ?? 'http://172.17.0.1:3006').replace(/\/$/, '');
  // 2026-06-06: tenant→portal usa shared PORTAL_CALLBACK_TOKEN (= portal global
  // secret), fallback al per-tenant token per back-compat container vecchi.
  const internalToken = getOutboundPortalToken();
  if (!internalToken) {
    throw new Error('Neither PORTAL_CALLBACK_TOKEN nor MEDEA_INTERNAL_TOKEN set in container env');
  }

  // Il portal route owner-only richiede cookie session. Per server-to-server
  // usiamo l'internal token su un endpoint dedicato (non c'e\` ancora — fallback
  // call diretta al portal con bypass via TENANT_ID + INTERNAL_TOKEN).
  // Per ora: chiamiamo la stessa funzione interna del portal via endpoint dedicato.
  const url = `${portalUrl}/api/v1/internal/runtime-status/${workspaceId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-Token': internalToken },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`portal returned ${res.status.toString()}: ${(await readTextTruncated(res, 65_536).catch(() => ({ text: '' }))).text.slice(0, 200)}`);
  }

  const portalData = await readJsonCapped<{
    ok: boolean;
    workspaceId: string;
    currentVersion: string | null;
    upgradeInProgress?: boolean;
    lastUpgradeAt?: string | null;
    pendingUpgrade: UpgradeInfoResponse['pendingUpgrade'];
  }>(res);

  return {
    workspaceId: portalData.workspaceId,
    currentVersion: portalData.currentVersion,
    upgradeAvailable: portalData.pendingUpgrade !== null,
    upgradeInProgress: portalData.upgradeInProgress ?? false,
    lastUpgradeAt: portalData.lastUpgradeAt ?? null,
    pendingUpgrade: portalData.pendingUpgrade,
    portalManageUrl: `https://flowforge.automazionezeli.com/workspaces/${workspaceId}/runtime`,
  };
}

export function createUpgradeInfoRoute(): Hono {
  const app = new Hono();

  app.get('/upgrade-info', async (c: Context) => {
    const workspaceId = process.env.MEDEA_TENANT_ID ?? '';
    if (!workspaceId) {
      return c.json({ ok: false, error: 'tenant id not configured' }, 503);
    }

    // Cache hit
    if (cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS && cache.data.workspaceId === workspaceId) {
      return c.json({ ok: true, ...cache.data, cached: true });
    }

    try {
      const data = await fetchFromPortal(workspaceId);
      cache = { data, fetchedAt: Date.now() };
      return c.json({ ok: true, ...data, cached: false });
    } catch (err) {
      log.warn({ err: String(err), workspaceId }, 'upgrade-info fetch failed');
      // Soft-fail: editor SPA mostra ZERO banner invece di errore
      return c.json({
        ok: true,
        workspaceId,
        currentVersion: null,
        upgradeAvailable: false,
        upgradeInProgress: false,
        lastUpgradeAt: null,
        pendingUpgrade: null,
        portalManageUrl: `https://flowforge.automazionezeli.com/workspaces/${workspaceId}/runtime`,
        cached: false,
        error: String(err),
      });
    }
  });

  return app;
}

// Test helper
export function _clearCache(): void { cache = null; }
