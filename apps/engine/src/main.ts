import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';
import { createServer } from './server.js';
import { runMigrations } from './storage/migrate.js';
import { closeDatabase } from './storage/db.js';
import { attachCollabServer } from './lib/y-collab.js';
import { getAuthKeys } from './lib/auth-keys.js';
import { InMemoryEventBus } from './adapters/event-bus-memory.js';
import { SchedulerService } from './services/scheduler.service.js';
import { TriggerWatchersService } from './services/trigger-watchers.service.js';
import { WorkerCoordinationService } from './services/worker-coordination.service.js';
import { CheckpointRecoveryService, CheckpointService } from './services/checkpoint.service.js';
import { PausedWorkflowsService } from './services/paused-workflows.service.js';
import { RunService } from './services/run.service.js';
import { startErrorOutbox } from './services/error-outbox/bootstrap.js';
import { AIInteractionsService } from './services/ai-interactions.service.js';

// Global safety net — log + exit con stack su crash silenti del runtime
// (e.g. promise rejection non handled durante startup async).
//
// Cappella Sistina #2 (2026-06-09): errori da modulo `lib0` o `yjs` NON
// causano process.exit. Ragione: un client browser con state Y.Doc corrotto
// può lanciare "Unexpected end of array" durante decode WS — non è un crash
// del runtime, è un input malformato del peer. Killare il container
// toglierebbe servizio a TUTTI i tenant per un singolo doc rotto di UNO.
// Log strutturato + continue.
process.on('uncaughtException', (err) => {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  const isYjsError = /[/\\]node_modules[/\\](?:\.pnpm[/\\])?(lib0|yjs)[@/\\]/.test(stack);
  if (isYjsError) {
    logger.error(
      { err, soft: true },
      '[y-collab] uncaughtException da lib0/yjs — softened (container NON exit)',
    );
    return;
  }
  console.error('[FATAL] uncaughtException:', err);
  logger.fatal({ err }, 'uncaughtException — process exiting');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
  logger.fatal({ reason }, 'unhandledRejection — process exiting');
  process.exit(1);
});

/** Maschera password nei URL Redis per log (redis://user:PASSWORD@host → redis://user:***@host). */
function redactCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info(
    { env: config.NODE_ENV, port: config.PORT, host: config.HOST },
    'Starting FlowForge runtime',
  );

  // SSRF: installa il dispatcher sicuro come GLOBALE per il `fetch` di Node →
  // protegge OGNI fetch raw del runtime (action_http + ogni executor stdlib) dal
  // DNS-rebinding, validando l'IP della socket al momento della connessione. Le
  // chiamate ai servizi interni trusted usano un dispatcher permissivo per-call
  // (safeOutboundFetch allowPrivateHost → internalAwareFetch).
  const { installGlobalSecureDispatcher } = await import('./lib/secure-dispatcher.js');
  installGlobalSecureDispatcher();
  logger.info('SSRF: global secure dispatcher installed (connect.lookup anti-rebinding)');

  // OpenTelemetry init — no-op se OTEL_EXPORTER_OTLP_ENDPOINT non set.
  // Quando set: SDK Node con auto-instrumentation (http/pg/ioredis) +
  // registrazione del tracer custom per `withSpan` di stdlib (globalThis
  // bridge) — gli executor del workflow emettono span flowforge.* con
  // tenantId/runId/nodeId attr automatici.
  // Chiamato PRIMA di runMigrations cosi\` anche DB queries setup hanno trace.
  const { initOtel, shutdownOtel } = await import('./lib/otel.js');
  initOtel();
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const { trace } = await import('@opentelemetry/api');
      const { registerTracer } = await import('@medea/engine-nodes-stdlib');
      const otelTracer = trace.getTracer('flowforge-nodes');
      // Bridge da @opentelemetry/api Tracer a stdlib MinimalTracer interface.
      registerTracer({
        startActiveSpan(name, fn) {
          return otelTracer.startActiveSpan(name, (span) => fn(span as never));
        },
      });
      logger.info('Custom tracer registered — stdlib withSpan() emette span verso OTLP collector');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Custom tracer register failed (OTel disabled per stdlib)',
      );
    }
  }

  runMigrations();

  // Wire idempotency store distribuito — 3-tier resolution:
  //   1. MEDEA_IDEMPOTENCY_REDIS_URL (dedicated, isolation completa)
  //   2. MEDEA_QUEUE_MODE=redis + MEDEA_REDIS_URL (riusa pool BullMQ)
  //   3. MEDEA_REDIS_URL standalone (single-pod + Redis esterno)
  //   altrimenti: InMemoryIdempotencyStore (zero-config dev/test)
  // Senza Redis, multi-pod retry causerebbero duplicate POST cross-pod.
  const { createRedisIdempotencyStoreIfEnabled, closeManagedRedisConnection } =
    await import('./lib/idempotency-redis.js');
  const resolution = await createRedisIdempotencyStoreIfEnabled();
  if (resolution) {
    // Wrap con circuit breaker: dopo 5 acquire falliti consecutivi → OPEN per
    // 30s. Workflow durante outage Redis non aspetta 5s commandTimeout per
    // OGNI write node — primi 5 trippano il breaker, poi fast-fail (1ms)
    // fino a probe HALF_OPEN. Workflow con 10 write nodes durante outage:
    //   - Senza CB: ~50s cumulativi (5s × 10)
    //   - Con CB: ~25s (5s × 5 trip, poi fast-fail × 5)
    const { CircuitBreakerIdempotencyStore } = await import('./lib/idempotency-circuit-breaker.js');
    const { setDefaultIdempotencyStore } = await import('@medea/engine-nodes-stdlib');
    const wrapped = new CircuitBreakerIdempotencyStore(resolution.store, {
      failureThreshold: 5,
      resetTimeout: 30_000,
      successThreshold: 2,
    });
    setDefaultIdempotencyStore(wrapped);
    logger.info(
      { source: resolution.source, redisUrl: redactCredentials(resolution.redisUrl) },
      'Idempotency backend: Redis (multi-pod safe) + circuit breaker (fail-fast outage)',
    );
  } else {
    logger.info(
      'Idempotency backend: in-memory (single-pod fallback — set MEDEA_REDIS_URL per multi-pod safety)',
    );
  }
  // Graceful shutdown hook — chiude la connection Redis dedicata (no-op se
  // riusata da BullMQ). Senza, restart fast leakerebbe socket.
  const shutdownIdempotency = async (): Promise<void> => {
    try {
      await closeManagedRedisConnection();
    } catch {
      /* best effort */
    }
  };
  const shutdownAll = async (): Promise<void> => {
    await Promise.allSettled([shutdownIdempotency(), shutdownOtel()]);
  };
  process.once('SIGTERM', () => {
    void shutdownAll();
  });
  process.once('SIGINT', () => {
    void shutdownAll();
  });

  const eventBus = new InMemoryEventBus();

  // ─── Migrazione webhook-ref (indirection, post-mortem Streammy) ───
  // Idempotente: converte i link webhook cablati (token nel path) in ref://
  // simbolici. Non-bloccante: un fallimento è loggato ma il boot prosegue —
  // i workflow non migrati restano com'erano (nessun peggioramento).
  try {
    const { runWebhookRefMigration } = await import('./services/webhook-ref-migration.service.js');
    const report = await runWebhookRefMigration(eventBus);
    if (report.linksConverted > 0) {
      logger.info(report, 'Migrazione webhook-ref completata: link cablati → ref:// (indirection)');
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Migrazione webhook-ref fallita — boot prosegue, workflow invariati',
    );
  }

  // ─── D1 telemetry emitter — battle-testing badge stable/beta ───
  // Subscribe a run.step → flush batch al portal ogni 30s o 100 eventi.
  // MEDEA_TENANT_ID è source-of-truth (env settato da onboarding.ts).
  const tenantIdForTelemetry = process.env.MEDEA_TENANT_ID ?? '';
  if (tenantIdForTelemetry) {
    const { telemetryEmitter } = await import('./lib/telemetry-emitter.js');
    telemetryEmitter.start(eventBus, tenantIdForTelemetry);
  }

  // ─── Janitor — Data Quality Self-Healing ───
  // Costruito qui (NON dentro createServer) per poterne controllare il
  // lifecycle: start() dopo la migration, stop() durante shutdown.
  // L'instance viene poi iniettato nelle route via deps.
  const { createJanitorRuntime } = await import('./services/janitor/index.js');
  const { setJanitor } = await import('./services/janitor/janitor.singleton.js');
  const { DbStudioService } = await import('./services/db-studio.service.js');
  const janitor = createJanitorRuntime({
    dbStudio: new DbStudioService(),
  });
  // Singleton accessor — gli executor (es. action_janitor_cleanup) lo
  // recuperano tramite getJanitor() senza riceverlo come prop.
  setJanitor(janitor);
  await janitor.start();

  const app = await createServer({ eventBus, janitor });
  const keys = await getAuthKeys();

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    logger.info({ port: info.port, host: info.address }, 'FlowForge runtime listening');
  });

  // 2026-06-09 FIX CRITICO: #7 Tier 2 (Yjs CRDT real-time collab) era wired solo
  // in bin/flowforge.ts (CLI standalone) ma NON in main.ts (entrypoint Docker
  // prod). Risultato: /collab/:wfid/:token rispondeva 404 e l'edit simultaneo
  // multi-user NON era LIVE pur essendo testato. Fix: stesso wire-up del CLI.
  attachCollabServer(server as unknown as HttpServer, keys.publicKeyPem);
  logger.info('Y.js collab WebSocket server attached at /collab/:workflowId/:token');

  const { attachCustomNodeLspServer } = await import('./lsp/ws-handler.js');
  attachCustomNodeLspServer(server as unknown as HttpServer, keys.publicKeyPem);
  logger.info('Custom Node LSP attached at /api/v1/custom-nodes/lsp');

  const scheduler = new SchedulerService(eventBus);
  await scheduler.start();
  // Singleton registration: il portal sweeper interroga
  // /api/v1/internal/cron-schedules-count per evitare di pausare un container
  // con cron attivi (SIGSTOP fermerebbe il setInterval del scheduler).
  SchedulerService.registerInstance(scheduler);

  const triggerWatchers = new TriggerWatchersService(eventBus);
  await triggerWatchers.start();

  // AI interactions retention sweep — daily cleanup of training-set rows
  // past their retention_until. We run an immediate sweep at boot + every
  // 24h after that. Non-blocking, errors are logged but don't crash boot.
  const aiInteractions = new AIInteractionsService();
  try {
    const swept = aiInteractions.sweep();
    if (swept.deleted > 0) logger.info({ deleted: swept.deleted }, 'ai_interactions sweep at boot');
  } catch (err) {
    logger.error({ err }, 'ai_interactions sweep at boot failed');
  }
  const aiSweepTimer = setInterval(
    () => {
      try {
        aiInteractions.sweep();
      } catch (err) {
        logger.error({ err }, 'ai_interactions sweep failed');
      }
    },
    24 * 60 * 60 * 1000,
  );
  // unref so the interval doesn't keep the process alive in tests
  aiSweepTimer.unref();

  // PHASE 6 — AI Conversations GDPR purge cron (hard-delete > 30gg post soft-delete).
  // Part of AI-SCALING-100-TENANTS architecture (docs/AI-SCALING-100-TENANTS.md).
  // Catch-up sweep at boot + daily after that. Non-blocking.
  try {
    const { startGdprPurgeCron } = await import('./services/ai-conversations/gdpr-purge.cron.js');
    startGdprPurgeCron();
  } catch (err) {
    logger.error({ err }, 'ai_conversations gdpr purge cron init failed');
  }

  // Runtime metrics reporter — 10min cron POST p50/p95/p99 + error rate al
  // portal /api/v1/internal/runtime-metrics. Popola banner SLA dashboard.
  try {
    const { startRuntimeMetricsReporter } = await import('./services/runtime-metrics-reporter.js');
    startRuntimeMetricsReporter();
  } catch (err) {
    logger.error({ err }, 'runtime-metrics-reporter init failed');
  }

  // F3 Cappella (2026-06-07): cron settimanale che archivia runs vecchi.
  try {
    const { startRunsArchiveCron } = await import('./services/runs-archive-cron.js');
    startRunsArchiveCron();
  } catch (err) {
    logger.error({ err }, 'runs-archive-cron init failed');
  }

  // F4 Cappella (2026-06-07): cron orario che vigila la quota log + alert.
  try {
    const { startLogQuotaWatcher } = await import('./services/log-quota-watcher.js');
    startLogQuotaWatcher();
  } catch (err) {
    logger.error({ err }, 'log-quota-watcher init failed');
  }

  // GAP 2 binary (2026-06-11): cron orario GC blob orfani del BinaryStore.
  // Senza, i blob de-referenziati (run archiviate/cancellate) si accumulano
  // sul loop ext4 del tenant fino all'ENOSPC.
  try {
    const { startBinaryGcCron } = await import('./services/binary-gc-cron.js');
    startBinaryGcCron();
  } catch (err) {
    logger.error({ err }, 'binary-gc-cron init failed');
  }

  // Distributed-mode worker registration + heartbeat + admin control intents.
  // Always on (even in single-node deployments) so the admin UI can show
  // "1 worker" status and queue restart/drain/concurrency-change actions.
  const workerCoordination = new WorkerCoordinationService();
  workerCoordination.register(process.env.npm_package_version);
  workerCoordination.start((action, concurrency) => {
    // BullMQ concurrency hot-swap would be wired here if running in REDIS
    // mode. For in-memory mode there's no separate concurrency knob, so we
    // just log the intent and the heartbeat updates the DB column.
    logger.info({ action, concurrency }, 'Worker control intent applied');
  });

  // Checkpoint recovery — picks up runs interrupted by a crash and resumes
  // them from the latest snapshot. Runs once at boot, non-blocking.
  const checkpointService = new CheckpointService();
  const runService = new RunService(eventBus);

  // Outbox errori DUREVOLE: consuma la coda delle notifiche d'errore (fan-out
  // error-workflow + onError webhook/email) enqueued atomicamente al mark-errored.
  // Dispatch at-least-once con retry/backoff, dead-letter, GC. Vedi services/error-outbox.
  const outboxScheduler = startErrorOutbox({ eventBus, runService });

  const recovery = new CheckpointRecoveryService(
    checkpointService,
    async (runId): Promise<void> => {
      await runService.resumeFromCheckpoint(runId);
    },
  );
  void recovery
    .recover()
    .then((count) => {
      if (count > 0) logger.info({ count }, 'Recovered interrupted runs from checkpoints');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Checkpoint recovery failed');
    });

  // Paused-workflows janitor — every 60s, sweep timed-out async frames
  // and fire their default payloads so workflows don't hang forever.
  const paused = new PausedWorkflowsService();
  const pausedJanitor = setInterval(() => {
    try {
      const swept = paused.sweepTimeouts();
      for (const row of swept) {
        runService.resumeFromPause(row).catch((err: unknown) => {
          logger.error({ err, pausedId: row.id }, 'Janitor failed to resume timed-out workflow');
        });
      }
    } catch (err) {
      logger.error({ err }, 'Paused-workflows janitor failed');
    }
  }, 60_000);
  // .unref() in aggiunta al clearInterval in shutdown — il pattern doppio
  // copre sia exit graceful (SIGTERM PM2 reload → shutdown handler) sia
  // exit anomalo (crash, kill -9 → solo unref previene zombie handle).
  pausedJanitor.unref();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    clearInterval(pausedJanitor);
    workerCoordination.stop();
    scheduler.stop();
    outboxScheduler.stop();
    void triggerWatchers.stop();
    void janitor.stop();
    server.close(() => {
      void closeDatabase();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Fatal startup error');
  process.exit(1);
});
