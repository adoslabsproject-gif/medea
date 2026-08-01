/**
 * community-trigger-runner — esegue il poll() di un community-trigger nel
 * sandbox isolated-vm (FEAT community-trigger runtime, 2026-06-09).
 *
 * Design (Cappella Sistina): un poll è semplicemente una chiamata
 * `runInSandbox` all'executor.js del nodo installato, con un protocollo
 * riservato — ZERO modifiche al sandbox (1018 righe collaudate: SSRF guard,
 * CPU timeout 15s, memory cap, fetch shim):
 *
 *   • Input  → config.__ff_trigger_poll = <triggerId> + input = { state }
 *   • Bridge → l'executor generato dall'SDK riconosce __ff_trigger_poll, esegue
 *              il poll(config, ctx, emit) del vendor con emit() che accumula gli
 *              eventi e ctx.state = lo stato persistito, poi ritorna
 *              { events, state }.
 *   • Output → { events, state } normalizzato qui.
 *
 * Lo STATE vive nell'host (trigger-watchers): viene passato dentro ad ogni poll
 * e ripersistito dal risultato. Il sandbox è stateless tra i poll (isolate
 * fresco per chiamata) → niente leak cross-poll, niente connessioni appese.
 *
 * Anti-abuse: il numero di eventi per singolo poll è cappato — un poll buggato
 * o malevolo che emette all'infinito non può inondare l'engine di run.
 */

import { runInSandbox } from '@/executors/community-node-sandbox.js';
import type { InstalledNode } from './community-nodes.service.js';
import { logger } from '@/lib/logger.js';

/** Cap difensivo: max eventi emessi da un singolo poll (anti-flood). */
export const MAX_EVENTS_PER_POLL = 1000;

export interface CommunityPollResult {
  events: unknown[];
  state: Record<string, unknown>;
  /** True se il poll ha emesso più di MAX_EVENTS_PER_POLL (events troncato). */
  truncated: boolean;
}

export interface PollContext {
  tenantId: string;
  workflowId: string;
  nodeId: string;
}

/**
 * Esegue un poll del trigger `triggerId` del nodo installato. Ritorna gli eventi
 * emessi + lo state aggiornato (da ripersistere per il prossimo poll).
 *
 * NON throwa per errori del vendor: il sandbox li propaga come reject, ma il
 * caller (trigger-watchers) vuole che un poll fallito NON tiri giù lo scheduler.
 * Qui invece propaghiamo l'errore (il caller lo cattura e logga per-poll) — così
 * un errore di config (es. API key mancante) è visibile, non silenziato.
 */
export async function runCommunityTriggerPoll(
  installed: InstalledNode,
  triggerId: string,
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  ctx: PollContext,
): Promise<CommunityPollResult> {
  const sandboxConfig: Record<string, unknown> = { ...config, __ff_trigger_poll: triggerId };
  const raw = await runInSandbox(installed.executorSource, {
    config: sandboxConfig,
    input: { state },
    context: {
      tenantId: ctx.tenantId,
      // runId sintetico: i poll non sono run del workflow, ma il sandbox
      // richiede un id per il logging/tracing.
      runId: `poll:${ctx.workflowId}:${triggerId}`,
      workflowId: ctx.workflowId,
      nodeId: ctx.nodeId,
    },
  });
  return normalizePollResult(raw, { defId: installed.def.id, triggerId });
}

/**
 * Normalizza l'output grezzo del sandbox in { events, state } robusto.
 * Difensivo contro un vendor che ritorna forme inattese (null, array, numero,
 * events non-array, state non-oggetto) — niente crash, defaults sicuri.
 */
export function normalizePollResult(
  raw: unknown,
  meta?: { defId?: string; triggerId?: string },
): CommunityPollResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { events: [], state: {}, truncated: false };
  }
  const obj = raw as Record<string, unknown>;

  let events: unknown[] = Array.isArray(obj.events) ? obj.events : [];
  let truncated = false;
  if (events.length > MAX_EVENTS_PER_POLL) {
    logger.warn(
      { ...meta, emitted: events.length, cap: MAX_EVENTS_PER_POLL },
      'community-trigger poll ha emesso oltre il cap — events troncato',
    );
    events = events.slice(0, MAX_EVENTS_PER_POLL);
    truncated = true;
  }

  const state =
    obj.state !== null && typeof obj.state === 'object' && !Array.isArray(obj.state)
      ? (obj.state as Record<string, unknown>)
      : {};

  return { events, state, truncated };
}

/** Clamp dell'intervallo di poll [10, 3600] secondi (allineato a NodeTriggerSchema). */
export function clampPollIntervalSec(raw: unknown, fallback = 60): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 10), 3600);
}
