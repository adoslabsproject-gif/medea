/**
 * trigger-watchers/community-trigger-poller — poller per community-trigger
 * mode='polling' (FEAT community-trigger runtime; split 2026-06-12, estratto
 * dal monolite TriggerWatchersService).
 *
 * Esegue il poll() del vendor nel sandbox isolated-vm ogni `pollIntervalSec`.
 * Lo state (cursore) vive QUI nell'host e viene ripassato a ogni poll → il
 * sandbox è stateless tra i poll (isolate fresco per chiamata), niente
 * connessioni appese.
 *
 * Invarianti (pinnate dai test):
 *   - no-overlap: poll in volo → il tick successivo è SALTATO, non accodato;
 *   - at-most-once: lo state è ripersistito PRIMA di avviare i run — un run
 *     fallito NON fa rigiocare l'evento (niente replay loop);
 *   - poll fallito → loggato, lo state NON cambia, il poller riprova;
 *   - config snapshot alla registrazione (mutazioni successive del nodo non
 *     toccano i poll in corso).
 *
 * Elevazione vs monolite (no downgrade): poll runner e dispatcher dei run sono
 * INIETTABILI (`CommunityTriggerPollerDeps`) — il metodo privato usava
 * `this.runs` e l'import diretto. Default = runner sandbox reale.
 */

import { logger } from '@/lib/logger.js';
import { runCommunityTriggerPoll, clampPollIntervalSec } from '../community-trigger-runner.js';
import type { InstalledNode } from '../community-nodes.service.js';
import type { DispatchTriggerRun } from './run-dispatcher.js';
import type { CanvasNode, NodeTrigger, Workflow } from '@medea/engine-core-schema';

export interface CommunityTriggerJob {
  workflowId: string;
  nodeId: string;
  timer: ReturnType<typeof setInterval> | null;
  /** Stato persistito tra i poll (cursore del vendor). */
  state: Record<string, unknown>;
  /** True mentre un poll è in volo — previene poll sovrapposti su sorgenti lente. */
  inFlight: boolean;
}

export interface CommunityTriggerPollerDeps {
  /** Avvia un run del workflow. In produzione: `RunService.execute`. */
  dispatchRun: DispatchTriggerRun;
  /** Poll runner nel sandbox isolated-vm. Default: `runCommunityTriggerPoll`. */
  pollRunner?: typeof runCommunityTriggerPoll;
}

/**
 * Avvia il poller per un community-trigger (mode='polling'). Persiste lo state
 * (cursore) nell'host e avvia un run del workflow per ogni evento emesso. Un
 * poll fallito NON tira giù lo scheduler (catch per-poll).
 */
export function startCommunityTriggerPoller(
  wf: Workflow,
  node: CanvasNode,
  installed: InstalledNode,
  trig: NodeTrigger,
  deps: CommunityTriggerPollerDeps,
): CommunityTriggerJob {
  const pollRunner = deps.pollRunner ?? runCommunityTriggerPoll;
  const tenantId = wf.tenantId ?? 'default';
  const triggerId = trig.id;
  const defId = installed.def.id;
  // node.config (Record<string,string>) ha priorità sull'intervallo di default
  // del trigger; clamp [10, 3600]s.
  const intervalSec = clampPollIntervalSec(node.config.pollIntervalSec ?? trig.pollIntervalSec, 60);
  // Snapshot della config del nodo (solo-stringa per CanvasNodeSchema).
  const config: Record<string, unknown> = { ...node.config };

  const job: CommunityTriggerJob = {
    workflowId: wf.id, nodeId: node.id, timer: null, state: {}, inFlight: false,
  };

  const poll = async (): Promise<void> => {
    // No overlap: se il poll precedente è ancora in volo (sorgente lenta),
    // salta questo tick invece di accodare poll sovrapposti.
    if (job.inFlight) return;
    job.inFlight = true;
    try {
      const result = await pollRunner(installed, triggerId, config, job.state, {
        tenantId, workflowId: wf.id, nodeId: node.id,
      });
      // Ripersisti lo state PRIMA di avviare i run: se un run fallisce, il
      // cursore è comunque avanzato (at-most-once per evento, niente loop).
      job.state = result.state;
      for (const event of result.events) {
        void deps
          .dispatchRun({
            workflowId: wf.id,
            tenantId,
            triggerType: `community:${defId}:${triggerId}`,
            triggerInput: event,
          })
          .catch((err: unknown) => {
            logger.error({ err, workflowId: wf.id, defId, triggerId }, 'community trigger run failed');
          });
      }
    } catch (err) {
      logger.error({ err, workflowId: wf.id, defId, triggerId }, 'community trigger poll failed');
    } finally {
      job.inFlight = false;
    }
  };

  job.timer = setInterval(() => { void poll(); }, intervalSec * 1000);
  logger.info({ workflowId: wf.id, defId, triggerId, intervalSec }, 'community trigger poller registered');
  return job;
}
