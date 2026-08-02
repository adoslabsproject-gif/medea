/**
 * AI Providers (LLM API keys) routes.
 *
 * GET    /llm-providers          → list (NEVER returns plaintext apiKey)
 * PUT    /llm-providers/:provider → set apiKey + defaults
 * DELETE /llm-providers/:provider → remove
 * POST   /llm-providers/:provider/test → ping the provider with a tiny prompt
 *
 * Only `owner` and `editor` roles can manage provider keys.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  LlmProvidersService,
  SUPPORTED_PROVIDERS,
  type LlmProvider,
} from '@/services/llm-providers.service.js';
import { getTenantId } from '@/lib/tenant.js';
import { getActorId } from '@/lib/actor.js';
import { TenantAiPreferencesService } from '@/services/tenant-ai-preferences.service.js';
import { requireRole } from '@/middleware/rbac.js';
import { logger } from '@/lib/logger.js';
import { isLiaraEnabled } from '@/config.js';
import { validateUrlForFetch } from '@medea/engine-safe-fetch';

const UpsertSchema = z.object({
  apiKey: z.string().max(2000).optional().default(''),
  defaultModel: z.string().max(200).optional().default(''),
  // SSRF: il baseUrl (BYOK custom: Ollama / proxy OpenAI-compat) è input utente
  // non-trusted e a runtime viene usato come target fetch. Senza guard si poteva
  // puntarlo a host interni (172.20.0.1 gateway, Redis, 169.254 IMDS, localhost)
  // → SSRF nella rete del server. Lo rifiutiamo al SALVATAGGIO (gate-a-sinistra);
  // allowDockerNet NON passato → blocca anche la flowforge-net. NB: ciò rende
  // Ollama-localhost non salvabile nel SaaS (corretto: nel cloud serve un
  // endpoint PUBBLICO; Ollama-locale è del guscio installabile).
  baseUrl: z
    .string()
    .max(500)
    .url()
    .optional()
    .or(z.literal(''))
    .refine((v) => !v || validateUrlForFetch(v).ok, {
      message:
        'baseUrl non ammesso: deve essere un endpoint HTTP(S) PUBBLICO. Host interni/privati/localhost sono bloccati (protezione SSRF).',
    }),
});

function isValidProvider(p: string): p is LlmProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

export function createLlmProvidersRoutes(): Hono {
  const app = new Hono();
  const service = new LlmProvidersService();
  const tenantPrefs = new TenantAiPreferencesService();

  app.get('/', (c) => {
    const tenantId = getTenantId(c);
    return c.json({ providers: service.list(tenantId) });
  });

  /**
   * GET /preferences — read tenant-level AI preferences + the effective
   * Liara state + the effective default provider used by the AI scaffold.
   * The UI uses this to render the "Allow Liara" toggle and the
   * "Default AI model" select.
   */
  app.get('/preferences', (c) => {
    const tenantId = getTenantId(c);
    const prefs = tenantPrefs.get(tenantId);
    const configured = service
      .list(tenantId)
      .filter((p) => p.hasKey)
      .map((p) => ({ provider: p.provider, hasKey: true }));
    return c.json({
      ...prefs,
      liaraGloballyEnabled: isLiaraEnabled(),
      liaraEffective: tenantPrefs.isLiaraAllowedForTenant(tenantId),
      effectiveDefaultLlmProvider: tenantPrefs.resolveDefaultProvider(tenantId, configured),
    });
  });

  /**
   * PUT /preferences — update tenant AI preferences. Editor role required.
   *
   * Both fields are optional: clients can update them independently
   * (the UI persists the toggle and the select separately).
   * `defaultLlmProvider` accepts:
   *   - a provider name (string) — must be one of the supported providers
   *     or 'liara'. If it isn't currently usable (no API key, Liara off,
   *     unknown name), the value is still persisted but `resolveDefaultProvider`
   *     will fall back to the chain — so the user sees the effective value
   *     in the GET response.
   *   - null — clear the preference; scaffold falls back to first configured
   *     external provider then Liara.
   */
  const PreferencesSchema = z.object({
    allowLiara: z.boolean().optional(),
    defaultLlmProvider: z.union([z.string().min(1).max(40), z.null()]).optional(),
  });
  app.put('/preferences', requireRole('editor'), zValidator('json', PreferencesSchema), (c) => {
    const tenantId = getTenantId(c);
    const body = c.req.valid('json');
    const patch: { allowLiara?: boolean; defaultLlmProvider?: string | null } = {};
    if (body.allowLiara !== undefined) patch.allowLiara = body.allowLiara;
    if (body.defaultLlmProvider !== undefined) patch.defaultLlmProvider = body.defaultLlmProvider;
    tenantPrefs.set(tenantId, patch);
    const configured = service
      .list(tenantId)
      .filter((p) => p.hasKey)
      .map((p) => ({ provider: p.provider, hasKey: true }));
    return c.json({
      ok: true,
      ...tenantPrefs.get(tenantId),
      liaraGloballyEnabled: isLiaraEnabled(),
      liaraEffective: tenantPrefs.isLiaraAllowedForTenant(tenantId),
      effectiveDefaultLlmProvider: tenantPrefs.resolveDefaultProvider(tenantId, configured),
    });
  });

  app.put('/:provider', requireRole('editor'), zValidator('json', UpsertSchema), async (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const providerParam = c.req.param('provider');
    if (!providerParam || !isValidProvider(providerParam)) {
      return c.json(
        { error: `Provider non valido. Supportati: ${SUPPORTED_PROVIDERS.join(', ')}` },
        400,
      );
    }
    const body = c.req.valid('json');
    try {
      const opts: { apiKey: string; defaultModel?: string; baseUrl?: string; actorId?: string } = {
        apiKey: body.apiKey ?? '',
      };
      if (body.defaultModel && body.defaultModel.trim() !== '')
        opts.defaultModel = body.defaultModel;
      if (body.baseUrl && body.baseUrl !== '') opts.baseUrl = body.baseUrl;
      if (actorId !== undefined) opts.actorId = actorId;
      await service.upsert(tenantId, providerParam, opts);
      return c.json({ ok: true, provider: providerParam });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Errore salvataggio' }, 400);
    }
  });

  app.delete('/:provider', requireRole('editor'), (c) => {
    const tenantId = getTenantId(c);
    const actorId = getActorId(c) ?? undefined;
    const providerParam = c.req.param('provider');
    if (!providerParam || !isValidProvider(providerParam)) {
      return c.json({ error: 'Provider non valido' }, 400);
    }
    if (providerParam === 'liara') {
      return c.json({ error: 'Liara è free-tier, non eliminabile.' }, 400);
    }
    const ok = service.remove(tenantId, providerParam, actorId);
    return c.json({ ok });
  });

  app.post('/:provider/test', requireRole('editor'), async (c) => {
    const tenantId = getTenantId(c);
    const providerParam = c.req.param('provider');
    if (!providerParam || !isValidProvider(providerParam)) {
      return c.json({ error: 'Provider non valido' }, 400);
    }
    const cfg = service.get(tenantId, providerParam);
    if (!cfg && providerParam !== 'liara') {
      return c.json({ error: 'Nessuna configurazione salvata per questo provider.' }, 404);
    }
    try {
      // Use a tiny prompt to check authentication; we ONLY surface success/error.
      const { dispatchLLMForTest } = await import('../services/llm-test.service.js');
      const start = Date.now();
      const reply = await dispatchLLMForTest(providerParam, cfg);
      return c.json({
        ok: true,
        durationMs: Date.now() - start,
        sample: reply.slice(0, 200),
      });
    } catch (err) {
      logger.warn({ provider: providerParam, err }, 'LLM provider test failed');
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  return app;
}
