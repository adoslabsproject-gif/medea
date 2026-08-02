/**
 * Registry client — fetches the community marketplace index from a remote URL.
 *
 * The registry is a STATIC JSON document (typically GitHub-hosted) whose URL
 * lives in MEDEA_REGISTRY_URL (defaults to the canonical one). Static
 * means: zero ops cost, free hosting, content-addressable signatures, easily
 * mirrored by self-hosters.
 *
 * Schema (the only contract third-party vendors care about):
 *
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-05-21T10:00:00Z",
 *     "nodes": [
 *       {
 *         "id": "community_pdf_tools",
 *         "vendor": "flowforge-community",
 *         "version": "1.0.0",
 *         "displayName": "PDF Tools",
 *         "description": "...",
 *         "license": "MIT",
 *         "category": "Document",
 *         "homepage": "https://...",
 *         "downloads": 1842,
 *         "rating": 4.8,
 *         "downloadUrl": "https://.../pdf-tools-1.0.0.ffnode",
 *         "iconUrl": "https://.../pdf-tools.svg",
 *         "actionsCount": 6,
 *         "aiActionsCount": 2,
 *         "publishedAt": "2026-05-21T10:00:00Z",
 *         "verified": true
 *       }
 *     ]
 *   }
 *
 * Caching strategy: in-process LRU with 5-minute TTL. The registry is
 * effectively immutable per release — we don't need fresh fetches per
 * request. Failed fetches return the last-good cache for up to 1 hour,
 * so a registry outage doesn't blank out the user's marketplace.
 */

import { z } from 'zod';
import { logger } from '@/lib/logger.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

/**
 * Accept null OR undefined for optional fields — the publish pipeline
 * emits JSON which uses null for "no rating yet" / "no homepage". Zod's
 * .optional() only accepts undefined, so .nullable().optional() is the
 * pattern that survives JSON round-trip.
 *
 * This was caught LIVE in production: GET /api/v1/community-nodes/registry
 * returned 502 because the registry JSON had "rating": null and Zod
 * rejected it. Add tests in nodes.test.ts to lock this contract.
 */
export const RegistryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/iu),
  vendor: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  displayName: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1),
  category: z.string().nullable().optional(),
  homepage: z.string().url().nullable().optional(),
  downloads: z.number().int().nonnegative().nullable().optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
  downloadUrl: z.string().url(),
  iconUrl: z.string().url().nullable().optional(),
  actionsCount: z.number().int().nonnegative().nullable().optional(),
  aiActionsCount: z.number().int().nonnegative().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  verified: z.boolean().nullable().optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistryIndexSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  nodes: z.array(RegistryEntrySchema),
});
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

const DEFAULT_REGISTRY_URL = 'https://flowforge.nothumanallowed.com/registry/nodes.json';
const TTL_MS = 5 * 60 * 1000;
const STALE_OK_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  data: RegistryIndex;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

function getUrl(): string {
  return process.env.MEDEA_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
}

/**
 * Fetch the registry. Honors the cache (5 min TTL). On network error,
 * returns the last-good cache up to 1 hour stale — better than empty.
 * Throws ONLY if there is no cache AND the fetch failed.
 */
export async function fetchRegistry(force = false): Promise<RegistryIndex> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < TTL_MS) {
    return cache.data;
  }

  const url = getUrl();
  try {
    const res = await safeOutboundFetch(url, {
      headers: { 'User-Agent': 'flowforge-runtime', 'Accept': 'application/json' },
      spanName: 'registry.fetch',
    });
    if (!res.ok) throw new Error(`Registry HTTP ${res.status.toString()}`);
    const raw = await readJsonCapped<unknown>(res);
    const parsed = RegistryIndexSchema.parse(raw);
    cache = { data: parsed, fetchedAt: now };
    logger.info({ url, entries: parsed.nodes.length }, 'Registry refreshed');
    return parsed;
  } catch (err) {
    logger.warn({ err, url }, 'Registry fetch failed');
    if (cache && now - cache.fetchedAt < STALE_OK_TTL_MS) {
      logger.info({ ageMs: now - cache.fetchedAt }, 'Serving stale registry cache');
      return cache.data;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Lookup an entry by vendor/id (used by the install-by-id endpoint).
 */
export async function findEntry(vendor: string, id: string): Promise<RegistryEntry | undefined> {
  const reg = await fetchRegistry();
  return reg.nodes.find((n) => n.vendor === vendor && n.id === id);
}

/**
 * Reset the cache — used by tests + admin "force refresh" button.
 */
export function clearRegistryCache(): void {
  cache = null;
}
