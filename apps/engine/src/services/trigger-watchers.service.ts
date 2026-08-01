/**
 * Trigger watchers — long-running listeners that fire workflows on external
 * events (file changes, new email). Companion to the SchedulerService (cron).
 *
 * Watchers are registered per workflow when:
 *   - workflow.enabled === true
 *   - workflow contains a matching trigger node
 *
 * On workflow update / disable, the corresponding watcher is torn down.
 */

import { logger } from '@/lib/logger.js';
import { WorkflowService } from './workflow.service.js';
import { RunService } from './run.service.js';
import { DbStudioService } from './db-studio.service.js';
import { getInstalledByDefId } from './community-nodes.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
// Re-export di back-compat (split 2026-06-12): i call-site/test storici
// importano queste primitive da questo modulo.
export { resolveJsonPointer, parseMarkSeen, parseAllowlist } from './trigger-watchers/parsing.js';
export { buildImapAttachment } from './trigger-watchers/imap-attachment.js';
import {
  startWebSocketWatcher,
  teardownWebSocketWatcher,
  type WebSocketWatcherJob,
} from './trigger-watchers/websocket-watcher.js';
import {
  startRabbitWatcher,
  teardownRabbitWatcher,
  type RabbitWatcherJob,
} from './trigger-watchers/rabbitmq-watcher.js';
import {
  startKafkaWatcher,
  teardownKafkaWatcher,
  type KafkaWatcherJob,
} from './trigger-watchers/kafka-watcher.js';
import { startDbChangePoller, type DbChangePollerJob } from './trigger-watchers/db-change-poller.js';
import { startCommunityTriggerPoller, type CommunityTriggerJob } from './trigger-watchers/community-trigger-poller.js';
import { startFileWatcher, type FileWatcherJob } from './trigger-watchers/file-watcher.js';
import { startOdooPoller, type OdooPollerJob } from './trigger-watchers/odoo-poller.js';
import { startImapPoller, type ImapPollerJob } from './trigger-watchers/imap-poller.js';
import { parseBounce } from './trigger-watchers/bounce-parser.js';

export class TriggerWatchersService {
  private readonly fileWatchers = new Map<string, FileWatcherJob>();
  private readonly imapPollers = new Map<string, ImapPollerJob>();
  private readonly dbChangePollers = new Map<string, DbChangePollerJob>();
  private readonly odooPollers = new Map<string, OdooPollerJob>();
  private readonly websocketWatchers = new Map<string, WebSocketWatcherJob>();
  private readonly rabbitWatchers = new Map<string, RabbitWatcherJob>();
  private readonly kafkaWatchers = new Map<string, KafkaWatcherJob>();
  /** Key: `${workflowId}::${nodeId}` (un workflow può avere più trigger community). */
  private readonly communityTriggerPollers = new Map<string, CommunityTriggerJob>();
  private readonly workflows: WorkflowService;
  private readonly runs: RunService;
  private readonly dbStudio: DbStudioService;
  /** Cleanup handle for the workflow.* subscription installed in start(). */
  private hotReloadUnsubscribe: (() => void) | null = null;
  /** Debounce timer to coalesce rapid-fire updates (e.g. save-while-typing). */
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventBus: IEventBus;

  constructor(eventBus: IEventBus) {
    this.eventBus = eventBus;
    this.workflows = new WorkflowService(eventBus);
    this.runs = new RunService(eventBus);
    this.dbStudio = new DbStudioService();
  }

  async start(): Promise<void> {
    await this.reload();
    // Hot reload — when ANY workflow is created/updated/deleted, debounced
    // reload of all watchers. Avoids the "save in UI → manual restart" loop.
    // Debounce: 500ms swallows the multiple save events emitted during a
    // rapid edit session.
    const onChange = (): void => {
      if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = setTimeout(() => {
        this.reloadDebounceTimer = null;
        this.reload().catch((err: unknown) => {
          logger.warn({ err }, 'TriggerWatchers hot-reload failed');
        });
      }, 500);
    };
    const unsubs = [
      this.eventBus.subscribeTo('workflow.created', onChange),
      this.eventBus.subscribeTo('workflow.updated', onChange),
      this.eventBus.subscribeTo('workflow.deleted', onChange),
    ];
    this.hotReloadUnsubscribe = (): void => { for (const u of unsubs) u(); };
    logger.info(
      {
        fileWatchers: this.fileWatchers.size,
        imapPollers: this.imapPollers.size,
        dbChangePollers: this.dbChangePollers.size,
        odooPollers: this.odooPollers.size,
        websocketWatchers: this.websocketWatchers.size,
        rabbitWatchers: this.rabbitWatchers.size,
        kafkaWatchers: this.kafkaWatchers.size,
      },
      'TriggerWatchers started (hot-reload enabled)',
    );
  }

  async stop(): Promise<void> {
    if (this.hotReloadUnsubscribe) {
      this.hotReloadUnsubscribe();
      this.hotReloadUnsubscribe = null;
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    for (const j of this.fileWatchers.values()) {
      await j.watcher.close();
    }
    this.fileWatchers.clear();
    for (const j of this.imapPollers.values()) {
      clearInterval(j.timer);
    }
    this.imapPollers.clear();
    for (const j of this.dbChangePollers.values()) {
      clearInterval(j.timer);
    }
    this.dbChangePollers.clear();
    for (const j of this.odooPollers.values()) {
      clearInterval(j.timer);
    }
    this.odooPollers.clear();
    for (const j of this.websocketWatchers.values()) {
      teardownWebSocketWatcher(j);
    }
    this.websocketWatchers.clear();
    for (const j of this.rabbitWatchers.values()) {
      teardownRabbitWatcher(j);
    }
    this.rabbitWatchers.clear();
    for (const j of this.kafkaWatchers.values()) {
      teardownKafkaWatcher(j);
    }
    this.kafkaWatchers.clear();
    for (const j of this.communityTriggerPollers.values()) {
      if (j.timer) clearInterval(j.timer);
    }
    this.communityTriggerPollers.clear();
  }

  async reload(): Promise<void> {
    // CRITICAL fix: must scan workflows of EVERY tenant, not just 'default'.
    // The previous `list('default')` silently ignored all multi-tenant
    // workflows — discovered when a zelisrl workflow was enabled but
    // imapPollers stayed at 0. `tenantId` for the run dispatch comes from
    // the workflow row itself (wf.tenantId), so multi-tenant isolation is
    // preserved correctly downstream.
    const list = await this.workflows.listAllAcrossTenants();
    const wantFile = new Set<string>();
    const wantImap = new Set<string>();
    const wantDbChange = new Set<string>();
    const wantOdoo = new Set<string>();
    const wantWebSocket = new Set<string>();
    const wantRabbit = new Set<string>();
    const wantKafka = new Set<string>();
    const wantCommunity = new Set<string>();

    for (const wf of list) {
      if (!wf.enabled) continue;
      for (const node of wf.nodes) {
        if (node.defId === 'trigger_file_watch') {
          wantFile.add(wf.id);
          if (!this.fileWatchers.has(wf.id)) {
            const job = await startFileWatcher(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
            });
            if (job) this.fileWatchers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_imap') {
          wantImap.add(wf.id);
          if (!this.imapPollers.has(wf.id)) {
            const job = startImapPoller(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
            });
            if (job) this.imapPollers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_email_bounce') {
          // Stesso poller IMAP + messageGate: SOLO i bounce (DSN) avviano il workflow,
          // payload arricchito con il BounceReport. Riusa la SAME map/lifecycle imap.
          wantImap.add(wf.id);
          if (!this.imapPollers.has(wf.id)) {
            const job = startImapPoller(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
              messageGate: (_parsed, rawSource) => {
                const bounce = parseBounce({ source: rawSource });
                return bounce !== null ? { dispatch: true, extra: { bounce } } : { dispatch: false };
              },
            });
            if (job) this.imapPollers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_db_change') {
          wantDbChange.add(wf.id);
          if (!this.dbChangePollers.has(wf.id)) {
            const job = startDbChangePoller(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
              getChangesSince: this.dbStudio.getChangesSince.bind(this.dbStudio),
            });
            if (job) this.dbChangePollers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_odoo_polling') {
          wantOdoo.add(wf.id);
          if (!this.odooPollers.has(wf.id)) {
            const job = startOdooPoller(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
            });
            if (job) this.odooPollers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_websocket') {
          wantWebSocket.add(wf.id);
          if (!this.websocketWatchers.has(wf.id)) {
            const job = startWebSocketWatcher(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
            });
            if (job) this.websocketWatchers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_rabbitmq') {
          wantRabbit.add(wf.id);
          if (!this.rabbitWatchers.has(wf.id)) {
            const job = startRabbitWatcher(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
            });
            if (job) this.rabbitWatchers.set(wf.id, job);
          }
        } else if (node.defId === 'trigger_kafka') {
          wantKafka.add(wf.id);
          if (!this.kafkaWatchers.has(wf.id)) {
            const job = startKafkaWatcher(wf, node, {
              dispatchRun: (input) => this.runs.execute(input),
            });
            if (job) this.kafkaWatchers.set(wf.id, job);
          }
        } else {
          // FEAT community-trigger runtime: il nodo è un community-trigger se il
          // suo defId risolve a un nodo installato che dichiara un trigger
          // POLLING, e node.config.__ff_trigger seleziona quale.
          const installed = getInstalledByDefId(node.defId);
          const triggerId = typeof node.config.__ff_trigger === 'string' ? node.config.__ff_trigger : '';
          const trig = installed?.def.triggers?.find((t) => t.id === triggerId && t.mode === 'polling');
          if (installed && trig) {
            const key = `${wf.id}::${node.id}`;
            wantCommunity.add(key);
            if (!this.communityTriggerPollers.has(key)) {
              const job = startCommunityTriggerPoller(wf, node, installed, trig, {
                dispatchRun: (input) => this.runs.execute(input),
              });
              this.communityTriggerPollers.set(key, job);
            }
          }
        }
      }
    }

    // Tear down watchers for workflows that are no longer enabled or no longer have triggers
    for (const id of [...this.fileWatchers.keys()]) {
      if (!wantFile.has(id)) {
        await this.fileWatchers.get(id)?.watcher.close();
        this.fileWatchers.delete(id);
      }
    }
    for (const id of [...this.imapPollers.keys()]) {
      if (!wantImap.has(id)) {
        const job = this.imapPollers.get(id);
        if (job) clearInterval(job.timer);
        this.imapPollers.delete(id);
      }
    }
    for (const id of [...this.dbChangePollers.keys()]) {
      if (!wantDbChange.has(id)) {
        const job = this.dbChangePollers.get(id);
        if (job) clearInterval(job.timer);
        this.dbChangePollers.delete(id);
      }
    }
    for (const id of [...this.odooPollers.keys()]) {
      if (!wantOdoo.has(id)) {
        const job = this.odooPollers.get(id);
        if (job) clearInterval(job.timer);
        this.odooPollers.delete(id);
      }
    }
    for (const id of [...this.rabbitWatchers.keys()]) {
      if (!wantRabbit.has(id)) {
        const job = this.rabbitWatchers.get(id);
        if (job) teardownRabbitWatcher(job);
        this.rabbitWatchers.delete(id);
      }
    }
    for (const id of [...this.kafkaWatchers.keys()]) {
      if (!wantKafka.has(id)) {
        const job = this.kafkaWatchers.get(id);
        if (job) teardownKafkaWatcher(job);
        this.kafkaWatchers.delete(id);
      }
    }
    for (const id of [...this.websocketWatchers.keys()]) {
      if (!wantWebSocket.has(id)) {
        const job = this.websocketWatchers.get(id);
        if (job) teardownWebSocketWatcher(job);
        this.websocketWatchers.delete(id);
      }
    }
    for (const key of [...this.communityTriggerPollers.keys()]) {
      if (!wantCommunity.has(key)) {
        const job = this.communityTriggerPollers.get(key);
        if (job?.timer) clearInterval(job.timer);
        this.communityTriggerPollers.delete(key);
      }
    }
  }

}
