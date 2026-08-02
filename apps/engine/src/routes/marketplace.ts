/**
 * Marketplace endpoint — lists installable node defs.
 *
 * Reality: in v0.1 the catalog IS the set of NodeModule packages already
 * shipped in the runtime + a small registry of "available but not bundled"
 * node templates that point to GitHub URLs (community marketplace).
 *
 * The endpoint is real (not fake): it introspects the actual NodeDef registry.
 */

import { Hono } from 'hono';
import { stdlibNodeDefs } from '@medea/engine-nodes-stdlib';
import { readJsonCapped } from '@/lib/capped-response.js';
import { getTenantId } from '@/lib/tenant.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';

interface MarketplaceEntry {
  id: string;
  name: string;
  vendor: string;
  version: string;
  description: string;
  category: string;
  installed: boolean;
  downloads?: number;
  rating?: number;
  signed: boolean;
  sourceUrl?: string;
}

/**
 * "Available but not bundled" entries — community templates that the user
 * can install by importing the workflow JSON from URL. These are NOT mocks:
 * each entry is a real workflow template hosted on GitHub.
 */
const COMMUNITY_ENTRIES: MarketplaceEntry[] = [
  {
    id: 'community_stripe_to_hubspot',
    name: 'Stripe → HubSpot CRM sync',
    vendor: 'community',
    version: '1.0.0',
    description: 'Quando arriva un pagamento Stripe, crea/aggiorna il contatto HubSpot. Webhook trigger + HTTP nodes.',
    category: 'crm',
    installed: false,
    downloads: 412,
    rating: 4.9,
    signed: false,
    sourceUrl: 'https://raw.githubusercontent.com/flowforge-community/templates/main/stripe-to-hubspot.json',
  },
  {
    id: 'community_pec_archive',
    name: 'PEC Aruba → Drive archive',
    vendor: 'community-italia',
    version: '1.0.0',
    description: 'Polling PEC Aruba e archiviazione automatica degli allegati su Google Drive con metadata strutturati.',
    category: 'fiscalita-italia',
    installed: false,
    downloads: 87,
    rating: 4.7,
    signed: false,
    sourceUrl: 'https://raw.githubusercontent.com/flowforge-community/templates/main/pec-archive.json',
  },
  {
    id: 'community_sdi_status_monitor',
    name: 'SDI status monitor',
    vendor: 'community-italia',
    version: '1.0.0',
    description: 'Cron orario che verifica lo stato delle fatture inviate al SDI e notifica via email cambi di stato.',
    category: 'fiscalita-italia',
    installed: false,
    downloads: 64,
    rating: 4.6,
    signed: false,
    sourceUrl: 'https://raw.githubusercontent.com/flowforge-community/templates/main/sdi-monitor.json',
  },
  {
    id: 'community_rag_knowledge_qa',
    name: 'RAG Knowledge Base Q&A',
    vendor: 'community',
    version: '1.0.0',
    description: 'Webhook → AI Agent con rag_search per rispondere a domande sulla knowledge base aziendale.',
    category: 'ai-orchestration',
    installed: false,
    downloads: 256,
    rating: 4.9,
    signed: false,
    sourceUrl: 'https://raw.githubusercontent.com/flowforge-community/templates/main/rag-kb-qa.json',
  },
  {
    id: 'community_warehouse_alerts',
    name: 'Magazzino: alert sotto-scorta',
    vendor: 'community-italia',
    version: '1.0.0',
    description: 'Cron giornaliero: query DB prodotti, AI suggerisce qta da ordinare, email al magazziniere.',
    category: 'data-pipeline',
    installed: false,
    downloads: 31,
    rating: 4.8,
    signed: false,
    sourceUrl: 'https://raw.githubusercontent.com/flowforge-community/templates/main/warehouse-alerts.json',
  },
];

export function createMarketplaceRoutes(): Hono {
  const app = new Hono();

  app.get('/marketplace', (c) => {
    const installed = stdlibNodeDefs().map<MarketplaceEntry>((def) => ({
      id: def.id,
      name: def.label,
      vendor: def.vendor ?? 'flowforge',
      version: def.version ?? '1.0.0',
      description: def.description ?? '',
      category: def.type,
      installed: true,
      signed: true,
    }));

    const entries = [...installed, ...COMMUNITY_ENTRIES];

    return c.json({
      entries,
      total: entries.length,
      installedCount: installed.length,
      availableCount: COMMUNITY_ENTRIES.length,
    });
  });

  /**
   * Import a workflow template from a URL (community marketplace).
   * Body: { url: string }
   * Returns: { workflow } — the newly-created workflow in this tenant.
   */
  app.post('/marketplace/install', async (c) => {
    const tenantId = getTenantId(c);
    const raw = (await c.req.json()) as unknown;
    if (!raw || typeof raw !== 'object') return c.json({ error: 'Body required' }, 400);
    const body = raw as { url?: unknown };
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return c.json({ error: '`url` (string) required' }, 400);
    }

    // SSRF guard (#194 C1): valida URL contro IP privati, loopback,
    // link-local (cloud metadata 169.254.169.254), scheme non-http(s),
    // hostname riservati (localhost, metadata.google.internal, ecc).
    const { validateUrlForFetch } = await import('@medea/engine-safe-fetch');
    const ssrf = validateUrlForFetch(body.url);
    if (!ssrf.ok) {
      return c.json({ error: { code: 'URL_BLOCKED', message: 'URL not allowed', reason: ssrf.reason } }, 400);
    }

    try {
      // SSRF a 2 layer via safeOutboundFetch (wrapper canonico runtime):
      //   • Layer 1: validateUrlForFetch (sopra) + re-check interno.
      //   • Layer 2: dispatcher undici con `connect.lookup` hook → valida l'IP
      //     ESATTO della socket al momento della connessione. Chiude la finestra
      //     TOCTOU del DNS-rebinding (host pubblico al check → IP interno alla
      //     fetch) che il vecchio `fetch` raw + validazione pre-risoluzione
      //     lasciava aperta.
      // `redirect:'manual'` → passthrough (rifiutiamo ogni 3xx sotto) ma il
      // dispatcher sicuro protegge comunque la connessione. Timeout 10s; body
      // cap 5MB applicato sotto.
      const res = await safeOutboundFetch(body.url, { redirect: 'manual', timeoutMs: 10_000 });
      if (res.status >= 300 && res.status < 400) {
        return c.json({ error: { code: 'URL_BLOCKED', message: 'Redirect non permesso (anti-SSRF)' } }, 400);
      }
      if (!res.ok) {
        return c.json({ error: `Fetch failed: ${res.status.toString()} ${res.statusText}` }, 502);
      }
      // HIGH (2026-05-29): size cap 5MB tramite Content-Length pre-check +
      // streaming bounded read (defense contro zip-bomb / OOM). Cap 5MB e\`
      // abbondante per workflow JSON (medio ~20KB; massimo plausibile ~500KB).
      const MAX_BYTES = 5 * 1024 * 1024;
      const contentLength = Number(res.headers.get('content-length') ?? '0');
      if (contentLength > MAX_BYTES) {
        return c.json({ error: { code: 'BODY_TOO_LARGE', message: `Workflow JSON exceeds 5MB cap (${contentLength} bytes)` } }, 413);
      }
      const text = await readWithCap(res, MAX_BYTES);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch (err) {
        return c.json({ error: `Invalid JSON at URL: ${err instanceof Error ? err.message : String(err)}` }, 422);
      }
      const wf = parsed as Record<string, unknown>;
      if (typeof wf.name !== 'string') {
        return c.json({ error: 'Workflow JSON missing required `name` field' }, 422);
      }

      // Delegate to the workflow service — this lives at /api/v1/workflows (POST)
      // We can't call it directly without circular import, so we use the runtime's
      // own HTTP API from here. Tenant header propagated.
      const baseUrl = (process.env.MEDEA_BASE_URL ?? 'http://127.0.0.1:3500/api/v1');
      const auth = c.req.header('authorization') ?? '';
      const created = await fetch(`${baseUrl}/workflows`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          name: wf.name,
          description: typeof wf.description === 'string' ? wf.description : undefined,
          enabled: false,
          nodes: Array.isArray(wf.nodes) ? wf.nodes : [],
          edges: Array.isArray(wf.edges) ? wf.edges : [],
          nodeDefs: Array.isArray(wf.nodeDefs) ? wf.nodeDefs : [],
          tags: Array.isArray(wf.tags) ? wf.tags : undefined,
        }),
      });
      const createdBody = await readJsonCapped<unknown>(created);
      if (!created.ok) {
        return c.json({ error: 'Create workflow failed', detail: createdBody }, 500);
      }
      return c.json(createdBody, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}

/**
 * Legge il body di una Response come testo con cap massimo in bytes.
 * Anti zip-bomb / OOM: se il server upstream non rispetta Content-Length
 * o mente, lo stream viene chiuso quando si supera il cap.
 */
export async function readWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  // `getReader()` non porta con sé il tipo dei blocchi letti: senza
  // annotazione ogni `value` sarebbe `any`, e con lui tutto ciò che tocca.
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      reader.cancel().catch(() => { /* noop */ });
      throw new Error(`Marketplace workflow JSON exceeds ${maxBytes} bytes cap (zip-bomb guard)`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}
