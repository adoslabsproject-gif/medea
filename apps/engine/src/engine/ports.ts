/**
 * Engine ports — the interfaces the WorkflowEngine depends on.
 *
 * Port-and-adapter (a.k.a. hexagonal) architecture: the engine declares
 * WHAT it needs (these interfaces) without knowing HOW it's implemented.
 * Concrete services (PausedWorkflowsService, CheckpointService) are
 * the adapters that satisfy these ports — injected via the engine's
 * constructor.
 *
 * Why this matters:
 *   • Test-friendly — pass an in-memory mock handler and exercise
 *     the engine without touching SQLite.
 *   • Replaceable — swap the SQLite-backed adapter for a Postgres or
 *     Redis-backed one without touching engine code.
 *   • Single Responsibility — the engine focuses purely on graph
 *     traversal & node execution; persistence is somebody else's job.
 *
 * Convention: each interface is prefixed `I` (Italian-friendly,
 * universal TS convention) and has a one-line summary + a doc-comment
 * for each method explaining the contract.
 */

import type { RunStep } from '@flowforge/core-schema';
import type { Readable } from 'node:stream';
import type { QueueItem } from './workflow-engine.js';
import type { RunItemGraph } from './item-model.js';

/**
 * Persistence side of an async-frame pause. Called by the engine when a
 * `logic_wait_signal` node is reached. The adapter must persist enough
 * state to rehydrate the workflow when the matching signal arrives.
 */
export interface IPauseHandler {
  /**
   * Persist the suspended state. Returns the id of the paused row, which
   * will be echoed in WorkflowRunResult.pausedId so the caller can map
   * "this run is waiting on row X".
   *
   * MUST be synchronous (or return string directly) so the engine can
   * pick the id up before exiting the BFS loop.
   */
  pause(args: PauseArgs): string;
}

export interface PauseArgs {
  runId: string;
  workflowId: string;
  tenantId: string;
  signalName: string;
  atNodeId: string;
  outputsById: Map<string, unknown>;
  visited: Set<string>;
  /**
   * Coda residua COMPLETA (QueueItem: include mapMode e sourceNodeId GAP #2).
   * Il tipo pieno garantisce che la serializzazione round-trip non "dimentichi"
   * dichiarativamente campi che a runtime viaggiano comunque nel JSON.
   */
  pendingQueue: QueueItem[];
  /**
   * GAP #2 (paired items): vista item-native della run (nodeId →
   * ExecutionItem[] con lineage). Persiste con lo snapshot così
   * `.item`/`itemMatching` risolvono anche DOPO il resume — i ref sono già
   * arricchiti di sourceNodeId alla registrazione, quindi il grafo è
   * autosufficiente (nessuna predecessor-map da ricostruire).
   */
  itemGraph: RunItemGraph;
  timeoutSeconds: number;
  defaultPayload: unknown;
  /** Match-key name from the wait_signal config (optional). */
  matchKey?: string;
  /** Match-value evaluated from the workflow expression (optional). */
  matchValue?: string;
}

/**
 * Persistence side of a periodic checkpoint. Called every N executed
 * nodes (N from engine config). The adapter writes the snapshot so a
 * process crash can resume the run from the last save point.
 */
export interface ICheckpointHandler {
  save(args: CheckpointArgs): void;
}

export interface CheckpointArgs {
  runId: string;
  workflowId: string;
  tenantId: string;
  atNodeId: string;
  outputsById: Map<string, unknown>;
  visited: Set<string>;
  /** Vedi PauseArgs.pendingQueue: tipo pieno QueueItem (mapMode + sourceNodeId). */
  pendingQueue: QueueItem[];
  /** Vedi PauseArgs.itemGraph: lineage persistito per il crash-recovery. */
  itemGraph: RunItemGraph;
  stepCount: number;
}

/**
 * No-op implementations — used as defaults when the engine is created
 * without injected adapters (e.g. unit tests). They simply discard the
 * call. Engine behavior degrades gracefully: pauses become no-ops (the
 * workflow halts without persistence), checkpoints are silently dropped.
 */
export const noopPauseHandler: IPauseHandler = {
  pause: (): string => '',
};

export const noopCheckpointHandler: ICheckpointHandler = {
  save: (): void => undefined,
};

/**
 * LLM provider lookup — used by AI/agent nodes that don't have a per-node
 * apiKey configured. The engine resolves the tenant's saved providers and
 * passes them through to the node executor's NodeExecutionContext.
 *
 * Defining this as a port (rather than importing the concrete service
 * directly) keeps the engine free of `services/` imports and makes unit
 * tests possible with a no-op provider map.
 */
export interface ILlmProviderRegistry {
  getAll(tenantId: string): Record<string, { apiKey: string; defaultModel?: string; baseUrl?: string }>;
}

export const noopLlmProviderRegistry: ILlmProviderRegistry = {
  getAll: (): Record<string, { apiKey: string; defaultModel?: string; baseUrl?: string }> => ({}),
};

/**
 * Global variable lookup — used by `$env.KEY` expressions. Resolved
 * per-tenant. Defining this as a port lets tests inject deterministic
 * env maps and avoids coupling the engine to the SQLite-backed service.
 */
export interface IGlobalVariableRegistry {
  /** Return a plain object map of {KEY: value} for the tenant. */
  getEnv(tenantId: string): Record<string, unknown>;
}

export const noopGlobalVariableRegistry: IGlobalVariableRegistry = {
  getEnv: (): Record<string, unknown> => ({}),
};

/**
 * Binary blob store tenant-scoped (GAP 2) — i nodi che producono/consumano file
 * lo usano via NodeExecutionContext.readBinary/writeBinary invece di passare
 * base64 dentro `outputsById`. Port (non import diretto del servizio) per tenere
 * l'engine disaccoppiato e testabile con un noop. L'adapter reale è
 * `BinaryStore` (content-addressed sul disco del tenant).
 */
export interface IBinaryStore {
  /** Legge i byte di un blob dal suo content-address (sha256). */
  read(ref: string): Promise<Buffer>;
  /** Scrive un buffer content-addressed; ritorna ref+sha256+size (dedup-safe). */
  writeBuffer(data: Buffer): Promise<{ ref: string; sha256: string; size: number }>;
  /**
   * Scrive uno stream content-addressed SENZA materializzare i byte in memoria
   * (hash calcolato in transito). È il path streaming reale per file grandi
   * (webhook upload 50MB, file-read di grossi file): i byte vanno disco→disco,
   * mai tutti in RAM.
   */
  writeStream(src: Readable): Promise<{ ref: string; sha256: string; size: number }>;
}

/**
 * Default no-op: fail-fast esplicito. Un engine senza binary store (alcuni test)
 * NON deve "silenziosamente" perdere i binari — se un nodo prova a leggerli/
 * scriverli senza store configurato, errore chiaro invece di dati corrotti.
 */
export const noopBinaryStore: IBinaryStore = {
  read: (): Promise<Buffer> => Promise.reject(new Error('IBinaryStore non configurato (read)')),
  writeBuffer: (): Promise<{ ref: string; sha256: string; size: number }> =>
    Promise.reject(new Error('IBinaryStore non configurato (writeBuffer)')),
  writeStream: (): Promise<{ ref: string; sha256: string; size: number }> =>
    Promise.reject(new Error('IBinaryStore non configurato (writeStream)')),
};

/**
 * Re-export RunStep here so adapters that build steps for the engine
 * have a single import surface.
 */
export type { RunStep };
