/**
 * D1 telemetry emitter (battle-testing):
 * Ascolta `run.step` dall'EventBus → accumula batch in-memory → flusha al portal
 * ogni 30s o ogni 100 eventi (whichever first). Fire-and-forget: errori network
 * vengono loggati ma non bloccano il run.
 *
 * Pattern: 1 sola HTTP call ogni N step → costo trascurabile.
 */
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { internalAwareFetch } from '@/lib/internal-service-fetch.js';
import { getOutboundPortalToken } from '@/lib/internal-token.js';

interface TelemetryEvent {
  defId: string;
  success: boolean;
  durationMs: number;
  tenantId: string;
  errorMsg?: string | null;
}

const PORTAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://host.docker.internal:3006';
// 2026-06-06 fix: il portal valida con il SUO global secret (MEDEA_INTERNAL_TOKEN
// del portal env), non con il per-tenant token. Usiamo PORTAL_CALLBACK_TOKEN che
// onboarding/provision propaga dal portal stesso. Fallback al per-tenant token solo
// per legacy compat (container creati prima del fix → 401 silente come prima).
const INTERNAL_TOKEN = getOutboundPortalToken();
const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER = 100;
// Skippa nodi non-executor (note, sticky, etc.) e logici (engine-handled)
const SKIP_DEF_IDS = new Set([
  'note', 'sticky',
  'logic_if', 'logic_switch', 'logic_loop', 'logic_merge', 'logic_delay',
  'logic_subworkflow', 'logic_wait', 'logic_wait_signal',
]);

class TelemetryEmitter {
  private buffer: TelemetryEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  start(bus: IEventBus, tenantId: string): void {
    if (this.timer) return;
    if (!INTERNAL_TOKEN) {
      logger.warn({}, '[TELEMETRY] MEDEA_INTERNAL_TOKEN missing — telemetry disabled');
      return;
    }
    this.unsubscribe = bus.subscribeTo('run.step', (event) => {
      const data = (event.data ?? {}) as { step?: { defId?: string; status?: string; durationMs?: number; error?: string } };
      const step = data.step;
      if (!step?.defId || SKIP_DEF_IDS.has(step.defId)) return;
      if (step.status !== 'success' && step.status !== 'error') return;
      this.buffer.push({
        defId: step.defId,
        success: step.status === 'success',
        durationMs: typeof step.durationMs === 'number' ? Math.max(0, step.durationMs) : 0,
        tenantId,
        errorMsg: step.error ?? null,
      });
      if (this.buffer.length >= MAX_BUFFER) void this.flush();
    });
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info({}, '[TELEMETRY] emitter started');
  }

  stop(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      // Portal interno trusted: internalAwareFetch bypassa il SSRF guard SOLO
      // perché PORTAL_URL è un servizio registrato (altrimenti la difesa
      // DNS-rebinding bloccherebbe l'IP privato del gateway Docker 172.17.0.1).
      const res = await internalAwareFetch(`${PORTAL_URL}/api/v1/internal/node-telemetry/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': INTERNAL_TOKEN,
        },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, count: batch.length }, '[TELEMETRY] portal ingest non-200');
      }
    } catch (err) {
      // Fire-and-forget: lost events sono accettabili (best-effort telemetry).
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[TELEMETRY] flush failed');
    }
  }
}

export const telemetryEmitter = new TelemetryEmitter();
