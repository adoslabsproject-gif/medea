/**
 * customNodeExecutor — esegue un Custom Node creato dal Custom Node Editor.
 *
 * Lifecycle:
 *   workflow engine → resolveServerExecutor(defId)
 *     defId.startsWith('custom_') ? → customNodeExecutor
 *       → loadCustomNodeForRun(defId, workspaceId)  [cache or DB]
 *         miss / non runnable → skip marker
 *         hit → runInSandbox(compiledExecutor)  [isolated-vm]
 *
 * Isolamento sicurezza: il compiledExecutor e\` un bundle esbuild IIFE
 * generato da compile.service.ts (security scan + esbuild). Niente
 * require/eval/process/fs — il sandbox isolated-vm fa l'ultimo enforcement.
 *
 * Hot-reload: il loader usa una cache invalidata da service.ts su update /
 * archive / publish / unpublish. Il prossimo run carica il nuovo executor
 * senza riavviare il container tenant.
 *
 * @module executors/custom-node
 */

import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { logger } from '@/lib/logger.js';
import { runInSandbox, type SandboxInput } from './community-node-sandbox.js';
import { loadCustomNodeForRun } from '@/services/custom-nodes/runtime-loader.js';
import { LogCollector } from '@/services/runs/log-collector.js';

export const customNodeExecutor: NodeExecutor = async (config, input, context) => {
  const startedAt = Date.now();
  const defId = context.defId ?? '';
  const workspaceId = context.tenantId;

  const entry = loadCustomNodeForRun(defId, workspaceId);
  if (!entry) {
    // Allineato a NodeExecutorStrategy skip-pattern: il resolver claim-a
    // qualunque defId con prefisso `custom_` ma se il nodo NON e\` registrato
    // (oppure non e\` published/compiled), ritorniamo uno skip strutturato
    // invece di throw — cosi\` l'engine continua e i workflow downstream
    // possono decidere come gestire (es. branching).
    return {
      output: {
        skipped: `Custom node "${defId}" non disponibile (non pubblicato / archiviato / non compilato). Apri "I Miei Nodi" e pubblica il nodo.`,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  logger.debug({
    workspaceId,
    defId,
    semver: entry.semver,
    status: entry.status,
  }, '[custom-node] dispatching');

  const sbCtx: SandboxInput['context'] = {
    tenantId: context.tenantId,
    runId: context.runId,
    workflowId: context.workflowId,
    nodeId: context.nodeId,
  };

  // L'IIFE esbuild esporta { executor, definition, schema } su un global
  // `__customNode`. Il sandbox bootstrap di community-node si aspetta uno
  // shape CJS (`module.exports = async function`). Adattiamo il source:
  // appendiamo un trailer che ri-esporta la funzione executor del bundle.
  const adapted = `${entry.compiledExecutor}
;module.exports = (typeof __customNode !== 'undefined' && typeof __customNode.executor === 'function')
  ? __customNode.executor
  : null;
`;

  // #226 Cappella Sistina+ logging: usa il collector del context engine se
  // presente (LogCollector istanziato a livello strategy), altrimenti ne
  // crea uno locale al fly (back-compat per chiamanti che non lo passano).
  type CtxWithCollector = typeof context & { __logCollector?: LogCollector };
  const collector = (context as CtxWithCollector).__logCollector
    ?? new LogCollector({
      runId: context.runId,
      stepNodeId: context.nodeId,
      workspaceId: context.tenantId,
      minLevel: 'debug',
    });

  collector.debug(`[custom-node] dispatching ${defId} (v${entry.semver})`, {
    defId, semver: entry.semver, status: entry.status,
  });

  // #226 Passa un trace per attivare la capture lato worker → al ritorno il
  // sandbox forwarda console.log+network al collector via forwardSandboxLogsToCollector.
  // Senza trace, captureTrace=false → worker NON ritorna trace.logs/network.
  const sbTrace = { logs: [] as string[], network: [] as { url: string; method: string; status: number; durationMs: number; bytesIn: number; ok: boolean; startedAt: number }[], durationMs: 0 };

  try {
    const result = await runInSandbox(adapted, {
      config,
      input,
      context: sbCtx,
      collector,
    }, sbTrace);
    // ROOT CAUSE #6 fix (2026-06-09): smart unwrap del result vendor.
    // Caso A: vendor ritorna NodeExecutionResult-shape `{ output, durationMs, ... }`
    //         (pattern stdlib-style: rotator, catalog, ecc compilati da
    //         _archive/streammy-sources/*/executor.ts). Propaga COSÌ COM'È
    //         così engine.res.output = vendor.output (NON wrappato di nuovo).
    // Caso B: vendor ritorna direttamente il payload utente
    //         `module.exports = async () => ({ foo: 'bar' })` (custom-node minimal).
    //         Wrappa noi in { output, durationMs }.
    //
    // Senza questo unwrap il template `$node.X.json.liveHost` accede a
    // `vars[X].liveHost` che è undefined (vero campo è `vars[X].output.liveHost`).
    // Conseguenza: downstream node riceve config interpolata vuota → CONFIG_INVALID.
    const isNodeResult = result !== null
      && typeof result === 'object'
      && 'output' in (result as Record<string, unknown>)
      && 'durationMs' in (result as Record<string, unknown>);
    if (isNodeResult) {
      const r = result as { output: unknown; durationMs: number; warnings?: string[]; branch?: string };
      return {
        output: r.output,
        durationMs: r.durationMs,
        ...(r.warnings ? { warnings: r.warnings } : {}),
        ...(r.branch ? { branch: r.branch } : {}),
      };
    }
    return {
      output: result,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Forward sandbox logs anche in caso di throw (es. NO_LIVE_HOST viene
    // throw dal bundle senza arrivare al postMessage success). Le entries
    // capturate prima del throw vengono comunque persistite nel collector.
    collector.error(`[custom-node] ${defId} failed: ${(err as Error).message}`, {
      defId, semver: entry.semver,
      sandboxLogCount: sbTrace.logs.length,
      sandboxNetCount: sbTrace.network.length,
    });
    throw err;
  }
};
