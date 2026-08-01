#!/usr/bin/env node
// IMPORTANT: env-bridge MUST be the first import — it remaps FLOWFORGE_PORT/HOST
// to PORT/HOST before logger.ts (a transitive dep) calls loadConfig() and caches.
import './env-bridge.js';
/**
 * FlowForge single-binary entry point.
 *
 * Modes:
 *   flowforge [serve]              — start the server, serve UI, open browser
 *   flowforge serve --no-open      — start the server without opening a browser (server install)
 *   flowforge worker               — start a BullMQ worker (FLOWFORGE_QUEUE_MODE=redis required)
 *   flowforge --help               — print usage
 *
 * Environment:
 *   FLOWFORGE_PORT           (default 3100)
 *   FLOWFORGE_HOST           (default 0.0.0.0)
 *   FLOWFORGE_DATA_DIR       (default ~/.flowforge)
 *   FLOWFORGE_DB_PATH        (default $DATA_DIR/flowforge.db)
 *   FLOWFORGE_MASTER_PASSWORD  REQUIRED in production for credential encryption
 *   FLOWFORGE_UI_DIR         (default: ./ui next to the binary or bundled)
 *   FLOWFORGE_BASE_URL       (default http://localhost:$PORT — used by AI Agent self-callbacks)
 *
 * Exit codes:
 *   0  clean shutdown
 *   1  unhandled startup error
 *   2  argument error
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { loadConfig } from '@/config.js';
import { logger } from '@/lib/logger.js';
import { createServer } from '@/server.js';
import { runMigrations } from '@/storage/migrate.js';
import { closeDatabase } from '@/storage/db.js';
import { attachCollabServer } from '@/lib/y-collab.js';
import { getAuthKeys } from '@/lib/auth-keys.js';
import { InMemoryEventBus } from '@/adapters/event-bus-memory.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { TriggerWatchersService } from '@/services/trigger-watchers.service.js';
import { startWorker, shutdownQueue, isQueueModeEnabled } from '@/services/queue.service.js';
import { RunService } from '@/services/run.service.js';
import { startErrorOutbox } from '@/services/error-outbox/bootstrap.js';
import { WorkerCoordinationService } from '@/services/worker-coordination.service.js';
import { CheckpointRecoveryService, CheckpointService } from '@/services/checkpoint.service.js';
import { PausedWorkflowsService } from '@/services/paused-workflows.service.js';
import { provisionTestAccount } from '@/services/test-account.service.js';
// AUDIT FIX H8 (2026-06-09): import services che main.ts wira ma bin/flowforge
// NON aveva. La parità è critica perché bin/flowforge è il binary distro
// `flowforge-desktop` + dev locale — senza GDPR purge, telemetry, metrics
// reporter, runs archive, log-quota watcher, AI sweep e Custom Node LSP la
// build CLI offre meno features della build Docker prod, in violazione del
// principio "binary distro = parità feature".
import { AIInteractionsService } from '@/services/ai-interactions.service.js';

function openBrowser(url: string): void {
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (p === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    logger.warn({ err, url }, 'Could not auto-open browser — open the URL manually.');
  }
}

function printBanner(host: string, port: number): void {
  const localUrl = host === '0.0.0.0' ? `http://localhost:${port.toString()}` : `http://${host}:${port.toString()}`;
   
  console.log('');
  console.log('  ╭───────────────────────────────────────────────────────╮');
  console.log('  │                                                       │');
  console.log('  │   ███████ ██       ██████  ██     ██                  │');
  console.log('  │   ██      ██      ██    ██ ██     ██   FlowForge      │');
  console.log('  │   █████   ██      ██    ██ ██  █  ██   workflow       │');
  console.log('  │   ██      ██      ██    ██ ██ ███ ██   automation     │');
  console.log('  │   ██      ███████  ██████   ███ ███                   │');
  console.log('  │                                                       │');
  console.log('  │   Open in your browser:                               │');
  console.log(`  │   ${localUrl.padEnd(53)}│`);
  console.log('  │                                                       │');
  console.log(`  │   API:        ${localUrl}/api/v1`.padEnd(56) + '│');
  console.log(`  │   Health:     ${localUrl}/health`.padEnd(56) + '│');
  console.log(`  │   MCP:        ${localUrl}/api/v1/mcp`.padEnd(56) + '│');
  console.log('  │                                                       │');
  console.log('  │   Press Ctrl+C to stop                                │');
  console.log('  ╰───────────────────────────────────────────────────────╯');
  console.log('');
   
}

async function runServe(args: string[]): Promise<void> {
  const config = loadConfig();
  const noOpen = args.includes('--no-open') || process.env.FLOWFORGE_NO_OPEN === '1';

  // Service-to-service internal token — used by executors that call the
  // runtime's own HTTP API (db_query, db_insert, rag_search, subworkflow,
  // invoke, etc.) to bypass session auth. Generated once per process boot,
  // injected into process.env so child code (node modules) sees it. It is
  // NEVER persisted, NEVER served, NEVER logged.
  if (!process.env.FLOWFORGE_INTERNAL_TOKEN) {
    process.env.FLOWFORGE_INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
  }

  logger.info({ env: config.NODE_ENV, port: config.PORT, host: config.HOST }, 'Starting FlowForge runtime');
  runMigrations();

  const eventBus = new InMemoryEventBus();

  // ─── Migrazione webhook-ref (indirection) — stesso wire-up di main.ts ───
  // (lezione collab 2026-06-09: gli entrypoint sono DUE, Docker E CLI.)
  try {
    const { runWebhookRefMigration } = await import('../services/webhook-ref-migration.service.js');
    const report = await runWebhookRefMigration(eventBus);
    if (report.linksConverted > 0) {
      logger.info(report, 'Migrazione webhook-ref completata: link cablati → ref:// (indirection)');
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Migrazione webhook-ref fallita — boot prosegue, workflow invariati');
  }

  // ─── Janitor — Data Quality Self-Healing ──────────────────────
  // Costruito qui (dopo migration, prima del server) per:
  //   • registrare lo `JanitorRuntime` nel singleton accessor → gli
  //     executor lo recuperano via getJanitor() senza prop-drilling
  //   • avviare lo scheduler (cron tick interno) PRIMA che il server
  //     accetti chiamate, così le route /janitor/* funzionano subito
  const { createJanitorRuntime } = await import('../services/janitor/index.js');
  const { setJanitor } = await import('../services/janitor/janitor.singleton.js');
  const { DbStudioService } = await import('../services/db-studio.service.js');
  const janitor = createJanitorRuntime({
    dbStudio: new DbStudioService(),
  });
  setJanitor(janitor);
  await janitor.start();
  logger.info('Janitor runtime initialized + singleton set');

  const app = await createServer({ eventBus, janitor });
  const keys = await getAuthKeys();

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    logger.info({ port: info.port, host: info.address }, 'FlowForge runtime listening');
    printBanner(config.HOST, info.port);
    if (!noOpen) {
      const target = config.HOST === '0.0.0.0' ? `http://localhost:${info.port.toString()}` : `http://${config.HOST}:${info.port.toString()}`;
      openBrowser(target);
    }
  });

  attachCollabServer(server as unknown as HttpServer, keys.publicKeyPem);

  // AUDIT FIX H8 (2026-06-09): Custom Node LSP attach — parità con main.ts.
  // Senza, l'editor del binary distro non ha autocomplete/types Monaco.
  try {
    const { attachCustomNodeLspServer } = await import('../lsp/ws-handler.js');
    attachCustomNodeLspServer(server as unknown as HttpServer, keys.publicKeyPem);
    logger.info('Custom Node LSP attached at /api/v1/custom-nodes/lsp');
  } catch (err) {
    logger.error({ err }, 'Custom Node LSP attach failed');
  }

  // Auto-provision the E2E test account when configured. No-op when the
  // env var isn't set, so this is safe to leave on by default in dev.
  await provisionTestAccount();

  // AUDIT FIX H8 (2026-06-09): telemetry emitter — parità con main.ts. Senza,
  // i tenant CLI non popolano battle-testing badge stable/beta nel registry
  // del portal (D1 telemetry).
  const tenantIdForTelemetry = process.env.FLOWFORGE_TENANT_ID ?? '';
  if (tenantIdForTelemetry) {
    try {
      const { telemetryEmitter } = await import('../lib/telemetry-emitter.js');
      telemetryEmitter.start(eventBus, tenantIdForTelemetry);
      logger.info({ tenantId: tenantIdForTelemetry }, 'Telemetry emitter started');
    } catch (err) {
      logger.error({ err }, 'Telemetry emitter init failed');
    }
  }

  // AUDIT FIX H8 (2026-06-09): GDPR purge cron — parità con main.ts.
  // Hard-delete soft-deleted ai_conversations > 30gg (DPIA art.17).
  try {
    const { startGdprPurgeCron } = await import('../services/ai-conversations/gdpr-purge.cron.js');
    startGdprPurgeCron();
  } catch (err) {
    logger.error({ err }, 'ai_conversations gdpr purge cron init failed');
  }

  // AUDIT FIX H8 (2026-06-09): runtime metrics reporter — parità con main.ts.
  // 10min POST p50/p95/p99 + error rate al portal → SLA dashboard banner.
  try {
    const { startRuntimeMetricsReporter } = await import('../services/runtime-metrics-reporter.js');
    startRuntimeMetricsReporter();
  } catch (err) {
    logger.error({ err }, 'runtime-metrics-reporter init failed');
  }

  // AUDIT FIX H8 (2026-06-09): runs archive cron — parità con main.ts.
  // F3 Cappella: archivia runs vecchi settimanalmente.
  try {
    const { startRunsArchiveCron } = await import('../services/runs-archive-cron.js');
    startRunsArchiveCron();
  } catch (err) {
    logger.error({ err }, 'runs-archive-cron init failed');
  }

  // AUDIT FIX H8 (2026-06-09): log quota watcher — parità con main.ts.
  // F4 Cappella: cron orario alert quota log per owner email.
  try {
    const { startLogQuotaWatcher } = await import('../services/log-quota-watcher.js');
    startLogQuotaWatcher();
  } catch (err) {
    logger.error({ err }, 'log-quota-watcher init failed');
  }

  // AUDIT FIX H8 (2026-06-09): AI interactions sweep — parità con main.ts.
  // Boot sweep + 24h cron training-set retention cleanup.
  const aiInteractions = new AIInteractionsService();
  try {
    const swept = aiInteractions.sweep();
    if (swept.deleted > 0) logger.info({ deleted: swept.deleted }, 'ai_interactions sweep at boot');
  } catch (err) {
    logger.error({ err }, 'ai_interactions sweep at boot failed');
  }
  const aiSweepTimer = setInterval(() => {
    try { aiInteractions.sweep(); } catch (err) { logger.error({ err }, 'ai_interactions sweep failed'); }
  }, 24 * 60 * 60 * 1000);
  aiSweepTimer.unref();

  const scheduler = new SchedulerService(eventBus);
  await scheduler.start();
  // Singleton registration: il portal sweeper interroga
  // /api/v1/internal/cron-schedules-count per evitare di pausare un container
  // con cron attivi (vedi services/scheduler.service.ts).
  SchedulerService.registerInstance(scheduler);
  const triggers = new TriggerWatchersService(eventBus);
  await triggers.start();

  // ──────────────────────────────────────────────────────────────
  // v2 enterprise features bootstrap
  // ──────────────────────────────────────────────────────────────
  // Worker fleet coordination: register this process in the workers
  // table, start heartbeat + janitor. Always on (single-node deployments
  // see 1 worker; distributed deployments see N).
  const workerCoordination = new WorkerCoordinationService();
  workerCoordination.register(process.env.npm_package_version);
  workerCoordination.start();

  // Checkpoint recovery: pick up runs that were 'running' when the process
  // crashed and resume them from the last snapshot. Non-blocking — runs
  // in the background after server is up.
  const checkpointService = new CheckpointService();
  const runService = new RunService(eventBus);

  // Outbox errori DUREVOLE (vedi services/error-outbox): consuma le notifiche
  // d'errore enqueued atomicamente al mark-errored — at-least-once, retry, dead-letter.
  const outboxScheduler = startErrorOutbox({ eventBus, runService });

  const recovery = new CheckpointRecoveryService(
    checkpointService,
    async (runId): Promise<void> => { await runService.resumeFromCheckpoint(runId); },
  );
  void recovery.recover().then((count) => {
    if (count > 0) logger.info({ count }, 'Recovered interrupted runs from checkpoints');
  }).catch((err: unknown) => {
    logger.error({ err }, 'Checkpoint recovery failed');
  });

  // Paused-workflows janitor: every 60s sweep for timed-out async frames
  // and resume them with their default payload.
  const pausedSvc = new PausedWorkflowsService();
  const pausedJanitor = setInterval(() => {
    try {
      const swept = pausedSvc.sweepTimeouts();
      for (const row of swept) {
        runService.resumeFromPause(row).catch((err: unknown) => {
          logger.error({ err, pausedId: row.id }, 'Janitor failed to resume timed-out workflow');
        });
      }
    } catch (err) {
      logger.error({ err }, 'Paused-workflows janitor failed');
    }
  }, 60_000);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'Shutting down…');
    try {
      clearInterval(pausedJanitor);
      clearInterval(aiSweepTimer);
      workerCoordination.stop();
      scheduler.stop();
      outboxScheduler.stop();
      await triggers.stop();
      await janitor.stop();
    } catch (err) {
      logger.warn({ err }, 'Error during scheduler/triggers shutdown');
    }
    server.close(() => {
      void closeDatabase();
      process.exit(0);
    });
    setTimeout(() => { process.exit(0); }, 5000).unref();
  };
  process.on('SIGINT', (sig) => { void shutdown(sig); });
  process.on('SIGTERM', (sig) => { void shutdown(sig); });
}

function runWorker(): void {
  if (!isQueueModeEnabled()) {
     
    console.error('FLOWFORGE_QUEUE_MODE is not "redis". Worker will not start.');
    process.exit(2);
  }
  const eventBus = new InMemoryEventBus();
  const runService = new RunService(eventBus);
  const worker = startWorker(async (data) => {
    const input: Parameters<RunService['execute']>[0] = {
      workflowId: data.workflowId,
      tenantId: data.tenantId,
    };
    if (data.triggerType !== undefined) input.triggerType = data.triggerType;
    if (data.triggerInput !== undefined) input.triggerInput = data.triggerInput;
    if (data.triggeredBy !== undefined) input.triggeredBy = data.triggeredBy;
    // runId pre-generato dal produttore: executeWithPins lo riusa (upsert
    // pending → running) invece di crearne uno nuovo.
    if (data.runId !== undefined) input.runId = data.runId;
    return runService.execute(input);
  });
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down…');
    await worker.close();
    await shutdownQueue();
    process.exit(0);
  };
  process.on('SIGINT', (sig) => { void shutdown(sig); });
  process.on('SIGTERM', (sig) => { void shutdown(sig); });
}

function printHelp(): void {
   
  console.log('flowforge — on-prem workflow automation\n');
  console.log('Usage:');
  console.log('  flowforge [serve]            Start API + UI server (opens browser)');
  console.log('  flowforge serve --no-open    Start without opening browser (server mode)');
  console.log('  flowforge worker             Start a BullMQ queue worker');
  console.log('  flowforge --help             Print this help');
  console.log('\nKey env vars:');
  console.log('  FLOWFORGE_PORT, FLOWFORGE_HOST, FLOWFORGE_DATA_DIR, FLOWFORGE_DB_PATH');
  console.log('  FLOWFORGE_MASTER_PASSWORD (required in production)');
  console.log('  FLOWFORGE_QUEUE_MODE=redis + FLOWFORGE_REDIS_URL (queue mode)');
  console.log('\nDocs: https://flowforge.dev/docs');
   
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const cmd = args[0];
  if (cmd === 'worker') {
    runWorker();
    return;
  }
  if (cmd === undefined || cmd === 'serve') {
    await runServe(args.slice(1));
    return;
  }
  if (cmd === 'promote-superadmin') {
    await runPromoteSuperadmin(args.slice(1));
    return;
  }
   
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(2);
}

/**
 * Promote a user to superadmin role. Cross-tenant visibility — the SaaS
 * provider's account. Run on the server CLI:
 *   flowforge promote-superadmin <email>
 */
async function runPromoteSuperadmin(args: string[]): Promise<void> {
  const email = args[0];
  if (!email) {
     
    console.error('Usage: flowforge promote-superadmin <email>');
    process.exit(2);
  }
  loadConfig();
  runMigrations();
  const { getDatabase } = await import('../storage/db.js');
  const { sqlite } = getDatabase();
  const row = sqlite.prepare('SELECT id, email, role FROM users WHERE email = ?').get(email) as { id: string; email: string; role: string } | undefined;
  if (!row) {
     
    console.error(`User not found: ${email}`);
    process.exit(1);
  }
  if (row.role === 'superadmin') {
     
    console.log(`User ${email} is already superadmin.`);
    return;
  }
  sqlite.prepare("UPDATE users SET role = 'superadmin', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
   
  console.log(`✓ User ${email} promoted from "${row.role}" to "superadmin". They will need to log in again to pick up the new role.`);
}

void main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
