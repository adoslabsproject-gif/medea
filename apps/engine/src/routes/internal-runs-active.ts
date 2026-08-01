/**
 * GET /api/v1/internal/runs-active
 *
 * Esposto al portal lifecycle sweeper per evitare di pausare un container con
 * run inflight. `docker pause` invia SIGSTOP a tutti i processi → fermerebbe
 * l'esecuzione del workflow a meta\` step (lo \`AbortController\` non si attiva
 * mai perche\` il processo Node e\` congelato). Il sweeper interroga questo
 * endpoint *prima* di chiamare pause: se \`active > 0\` salta il pause e
 * ritocca \`last_activity_at\` cosi\` il prossimo sweep ricontrolla.
 *
 * Auth: header `x-internal-token` timing-safe via `requireInternalToken()`
 * (single source di verifica S2S — vedi lib/internal-token.ts). Niente/errato
 * token → 401, fail-closed.
 */
import { Hono } from 'hono';
import { RunService } from '../services/run.service.js';
import { SchedulerService } from '../services/scheduler.service.js';
import { WorkflowService } from '../services/workflow.service.js';
import { InMemoryEventBus } from '../adapters/event-bus-memory.js';
import { loggerFor } from '../lib/logger.js';
import { requireInternalToken } from '../lib/internal-token.js';

const log = loggerFor('routes.internal-runs-active');

export function createInternalRunsActiveRoute(): Hono {
  const app = new Hono();

  // Gate S2S PER-ROUTE (non app.use): in Hono il middleware per-route si applica
  // SOLO a quella route, mentre `app.use('/internal/*')` su un sub-app montato
  // `app.route('/api/v1', ...)` leakava su /api/v1/dashboard (401 spurio, prod
  // 2026-06-11). `requireInternalToken` resta UN unico helper (logica consolidata),
  // solo l'applicazione è per-endpoint = scope garantito.
  const gate = requireInternalToken();

  app.get('/internal/runs-active', gate, (c) => {
    const active = RunService.getActiveRunCount();
    return c.json({ active }, 200);
  });

  /**
   * GET /api/v1/internal/cron-schedules-count
   *
   * Workflow `enabled=1` con un nodo `trigger_cron` sono registrati nel
   * SchedulerService in-process. SIGSTOP (docker pause) fermerebbe il
   * setInterval del tick → i job programmati salterebbero il firing.
   * Il portal sweeper interroga questo endpoint prima del pause: se
   * `count > 0` skip + touch lastActivityAt cosi\` i workflow cron
   * continuano a girare anche sui piani con auto-pause aggressivo.
   */
  app.get('/internal/cron-schedules-count', gate, (c) => {
    const count = SchedulerService.getActiveCronScheduleCount();
    return c.json({ count }, 200);
  });

  /**
   * GET /api/v1/internal/workflows-enabled-count
   *
   * Conta workflow `enabled=1` (qualsiasi tipo di trigger: manual, webhook,
   * cron, IMAP, polling, ecc). Usato dal portal sweeper per evitare di
   * pausare un container con workflow ATTIVI: anche un trigger_webhook che
   * serve una pagina pubblica diventerebbe irraggiungibile (404 dopo wake
   * delay) se il container e\` in sleep.
   *
   * Pattern semplice: workspace con anche 1 solo workflow enabled NON va
   * in sleep (politica "if it's live, keep it live"). I workspace vuoti
   * o con solo workflow disabilitati possono ancora andare in sleep per
   * risparmiare risorse — scale-to-zero ragionevole.
   */
  app.get('/internal/workflows-enabled-count', gate, async (c) => {
    try {
      // EventBus stub: WorkflowService non emette eventi in questa lettura
      // count-only, quindi un bus vuoto e\` safe (no listener riceve nulla).
      const service = new WorkflowService(new InMemoryEventBus());
      const count = await service.countEnabled();
      return c.json({ count }, 200);
    } catch (err) {
      log.warn({ err }, 'workflows-enabled-count failed');
      return c.json({ count: 0, error: 'count failed' }, 200);
    }
  });

  /**
   * POST /api/v1/internal/workspace/read-only   Body: { readOnly: boolean }
   *
   * Settato dal portal quando il workspace entra/esce dal disk over-quota grace
   * (Layer 2). read_only=true → RunService blocca l'esecuzione dei workflow
   * (manual/scheduled/triggered), mentre edit/delete/read restano consentiti.
   * Persistito in system_flags → sopravvive al restart del container.
   */
  app.post('/internal/workspace/read-only', gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { readOnly?: unknown } | null;
    if (!body || typeof body.readOnly !== 'boolean') {
      return c.json({ error: 'readOnly boolean required' }, 400);
    }
    const { setWorkspaceReadOnly } = await import('../services/readonly-flag.service.js');
    setWorkspaceReadOnly(body.readOnly);
    return c.json({ ok: true, readOnly: body.readOnly }, 200);
  });

  /**
   * POST /api/v1/internal/workspace/vector-quota
   * Body: { maxVectors: number|null, maxDiskMb: number|null }
   *
   * Spinto dal portal su cambio piano (up/downgrade, Inc.6): aggiorna LIVE i limiti
   * quota vettoriale enforced al rag_ingest/ingest-text/auto-embed, senza dipendere
   * dal recreate del container. Persistito in system_flags → sopravvive al restart.
   * null = illimitato (es. Enterprise/BYOK).
   */
  app.post('/internal/workspace/vector-quota', gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { maxVectors?: unknown; maxDiskMb?: unknown } | null;
    // Ogni limite deve essere number ≥ 0 oppure null (illimitato). Type-strict:
    // niente coercizione (string "0" o boolean → 400).
    const valid = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
    if (!body || !valid(body.maxVectors) || !valid(body.maxDiskMb)) {
      return c.json({ error: 'maxVectors e maxDiskMb richiesti: number>=0 oppure null' }, 400);
    }
    const { setVectorQuotaOverride } = await import('../services/vector-quota-flag.service.js');
    setVectorQuotaOverride({ maxVectors: body.maxVectors, maxDiskMb: body.maxDiskMb });
    return c.json({ ok: true, maxVectors: body.maxVectors, maxDiskMb: body.maxDiskMb }, 200);
  });

  /**
   * POST /api/v1/internal/workspace/egress-allowlist   Body: { hosts: string (CSV) }
   *
   * Spinto dal portal quando l'admin modifica la allowlist host-interni del tenant
   * (tab admin). SOLO verso questi host action_http può scavalcare il SSRF guard +
   * (se allowSelfSigned) accettare cert self-signed. Persistito in system_flags →
   * sopravvive al restart. Vuoto = feature OFF (nessun bypass).
   */
  app.post('/internal/workspace/egress-allowlist', gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hosts?: unknown } | null;
    if (!body || typeof body.hosts !== 'string') {
      return c.json({ error: 'hosts string (CSV) required' }, 400);
    }
    const { setEgressAllowlist } = await import('../lib/egress-policy.js');
    setEgressAllowlist(body.hosts);
    return c.json({ ok: true }, 200);
  });

  /**
   * POST /api/v1/internal/workspace/user-revoked
   * Body: { email: string, scrubPii?: boolean }
   *
   * F3 (2026-07-06): propagazione portal→runtime della revoca identità. Chiamato
   * best-effort dal portal quando un utente viene rimosso/sospeso/anonimizzato o
   * gli si revocano le sessioni. Identifica l'utente per EMAIL (chiave naturale
   * cross-system), revoca TUTTE le sessioni (cutoff) e, se scrubPii, anonimizza
   * la PII residua nel SQLite tenant + disabilita la riga. Idempotente.
   */
  app.post('/internal/workspace/user-revoked', gate, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; scrubPii?: unknown } | null;
    if (!body || typeof body.email !== 'string' || body.email.length === 0) {
      return c.json({ error: 'email string required' }, 400);
    }
    const { revokeWorkspaceUser } = await import('../services/security/user-revocation.js');
    const result = revokeWorkspaceUser({ email: body.email, scrubPii: body.scrubPii === true });
    return c.json({ ok: true, ...result }, 200);
  });

  return app;
}
