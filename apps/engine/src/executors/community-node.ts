/**
 * communityNodeExecutor — runs the executor source code shipped inside an
 * installed .ffnode package.
 *
 * Resolution path:
 *   workflow engine
 *     → resolveServerExecutor(defId)
 *       → findInstalledByDefId returns true
 *         → returns this executor
 *           → look up the InstalledNode by defId
 *           → load executorSource (already in memory)
 *           → execute INSIDE the isolated-vm sandbox (runInSandbox)
 *
 * SICUREZZA (stato REALE): l'executorSource gira in `runInSandbox`
 * (executors/community-node-sandbox.ts) = isolato in un V8-isolate dedicato
 * (memory cap, CPU timeout, no process/fs/require/eval, fetch SSRF-guarded).
 * NON è `new AsyncFunction()` (vecchia Phase 3, mai più in uso).
 *
 * ⚠️ Se qualcuno tocca runInSandbox: l'isolamento è il CONFINE di sicurezza
 * per il codice di terzi — non degradare a esecuzione in-process.
 */

import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { isBinaryData, readBinaryBytes, makeBinaryInline, type BinaryRefReader } from '@flowforge/core-schema';
import { getInstalledByDefId } from '@/services/community-nodes.service.js';
import { runInSandbox, type SandboxInput } from './community-node-sandbox.js';
import { logger } from '@/lib/logger.js';

/**
 * REF-PRIMARIO per i community node (boundary isolated-vm): un handle BinaryData
 * encoding='ref' è un riferimento al disco HOST — l'isolate NON può risolverlo
 * (la risoluzione è async + host-side). Quindi, prima di iniettare l'input nella
 * VM, convertiamo ricorsivamente ogni ref in INLINE base64 (leggendo i byte via
 * readBinary): così un community node alimentato da un handle piped (da pdf /
 * file-read / http download / imap) riceve i byte e li decodifica con atob.
 * I base64 INTERNI al sandbox (fetch proxy, crypto) restano transport — corretti.
 */
export async function inlineBinaryRefs(value: unknown, readBinary?: BinaryRefReader): Promise<unknown> {
  if (isBinaryData(value)) {
    if (value.encoding !== 'ref') return value; // già inline
    const bytes = await readBinaryBytes(value, readBinary);
    return makeBinaryInline({
      mimeType: value.mimeType, data: bytes.toString('base64'),
      ...(value.fileName !== undefined ? { fileName: value.fileName } : {}),
    });
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => inlineBinaryRefs(v, readBinary)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = await inlineBinaryRefs(v, readBinary);
    return out;
  }
  return value;
}

export const communityNodeExecutor: NodeExecutor = async (config, input, context) => {
  const startedAt = Date.now();
  const defId = context.defId ?? '';
  const installed = getInstalledByDefId(defId);
  if (!installed) {
    throw new Error(`Community node "${defId}" non trovato — disinstallato? Reinstalla dal Marketplace.`);
  }

  const action = typeof config.__action === 'string' ? config.__action : undefined;
  logger.debug({
    vendor: installed.manifest.vendor,
    id: installed.manifest.id,
    version: installed.manifest.version,
    action,
  }, 'Executing community node');

  const sbCtx: SandboxInput['context'] = {
    tenantId: context.tenantId,
    runId: context.runId,
    workflowId: context.workflowId,
    nodeId: context.nodeId,
  };
  if (action !== undefined) sbCtx.action = action;
  // REF-PRIMARIO: risolve i ref handle → inline base64 prima del boundary VM.
  const resolvedInput = await inlineBinaryRefs(input, context.readBinary);
  const output = await runInSandbox(installed.executorSource, {
    config,
    input: resolvedInput,
    context: sbCtx,
  });

  return {
    output: output,
    durationMs: Date.now() - startedAt,
  };
};

