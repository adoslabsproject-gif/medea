/**
 * Template cache (Livello 1) serving — estratto da singleshot.service.ts
 * (split NO-MONOLITI 2026-06-11). Ristrutturazione (NON verbatim): il blocco inline
 * use_direct → funzione che ritorna il risultato cachato O null (parse-fail/evict).
 * L'emit 'done' + il return + il reset di cacheRetrieve restano nel caller → zero
 * accoppiamento con l'emitter/flow del singleshot.
 *
 * Dipende dai moduli puri sottostanti (auto-fix, dataflow-validator, cache-quality).
 */
import { WorkflowSchema, type Workflow } from '@medea/engine-core-schema';
import { autoFixWorkflow } from '@/services/ai-scaffold/auto-fix.js';
import { validateDataflow } from '@/services/ai-scaffold/dataflow-validator.js';
import { shouldEvictCachedEntry } from '@/services/ai-scaffold/cache-quality.js';
import { templateCache, type RetrieveResult } from '@/services/ai-scaffold/template-cache/template.service.js';
import { type AiScaffoldResult } from '@/services/ai-scaffold/scaffold-runner.js';
import { type AiScaffoldTrace } from '@/services/ai-scaffold/types.js';
import { logger } from '@/lib/logger.js';

/**
 * Serve un workflow dalla template cache (use_direct hit). Ritorna il risultato
 * cachato pronto, oppure `null` se:
 *  - il workflow_json cachato non parsa (template corrotto), oppure
 *  - l'entry è di BASSA QUALITÀ → EVICT: heal strutturale (merge mancante/fan-in)
 *    o ERRORE data-flow (reachability) → la cancella e cade su generazione fresh.
 * I fix TRIVIALI (placeholder→secret) vengono applicati e il cached è usato.
 */
export function serveCachedWorkflow(cacheRetrieve: RetrieveResult, goal: string, start: number): AiScaffoldResult | null {
  let cachedWf: Workflow;
  try {
    cachedWf = WorkflowSchema.parse(JSON.parse(cacheRetrieve.template.workflowJson));
  } catch (parseErr) {
    logger.warn({ err: parseErr instanceof Error ? parseErr.message : String(parseErr) }, '[SINGLESHOT] cached workflow_json non parse — fallback singleshot');
    return null;
  }

  const cf = autoFixWorkflow({
    nodes: cachedWf.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    edges: cachedWf.edges.map((e) => ({ from: e.from, to: e.to })),
  });
  // Heal STRUTTURALE (merge mancante, fan-in) o ERRORE data-flow (reachability) =
  // grafo di bassa qualità → EVICT (non ri-proporlo come template buono). I warning
  // data-flow euristici NON evictano.
  const cachedDfFails = validateDataflow(
    cachedWf.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    cachedWf.edges.map((e) => ({ from: e.from, to: e.to })),
  ).filter((i) => i.status === 'fail');
  if (shouldEvictCachedEntry(cf.appliedFixes.map((f) => f.type)) || cachedDfFails.length > 0) {
    templateCache.delete(cacheRetrieve.template.id);
    logger.info({ templateId: cacheRetrieve.template.id, fixes: cf.appliedFixes.map((f) => f.type), dataflowFails: cachedDfFails.length }, '[SINGLESHOT] template cache entry EVICTED (heal strutturale o data-flow error = bassa qualità) → fresh generation');
    return null;
  }
  if (cf.appliedFixes.length > 0) {
    // Solo fix TRIVIALI (placeholder→secret) → applica e usa il cached.
    const origById = new Map(cachedWf.nodes.map((n) => [n.id, n]));
    cachedWf.nodes = cf.nodes.map((fn) => {
      const orig = origById.get(fn.id);
      return (orig
        ? { ...orig, defId: fn.defId, config: fn.config }
        : { id: fn.id, defId: fn.defId, config: fn.config, x: 0, y: 0 }) as (typeof cachedWf.nodes)[number];
    });
    cachedWf.edges = cf.edges.map((e) => ({ from: e.from, to: e.to }));
    logger.info({ templateId: cacheRetrieve.template.id, fixes: cf.appliedFixes.length }, '[SINGLESHOT] cached workflow auto-fixed on retrieval (triviale)');
  }

  const cachedDurationMs = Date.now() - start;
  const cachedTrace: AiScaffoldTrace[] = [{
    step: 1,
    tool: 'template_cache_hit',
    args: { templateId: cacheRetrieve.template.id, score: cacheRetrieve.score.toFixed(3) },
    result: { ok: true, data: { signals: cacheRetrieve.signals, nodes: cachedWf.nodes.length } },
    elapsedMs: cachedDurationMs,
  }];
  const cachedResult: AiScaffoldResult = {
    workflow: cachedWf,
    modelUsed: `template-cache (${cacheRetrieve.template.id})`,
    durationMs: cachedDurationMs,
    iterations: 1,
    trace: cachedTrace,
    notes: [
      `Template cache hit: score ${cacheRetrieve.score.toFixed(3)} (Jaccard ${cacheRetrieve.signals.promptJaccard.toFixed(2)}, success_rate ${cacheRetrieve.signals.successRate.toFixed(2)})`,
      `Template usato: "${cacheRetrieve.template.name}" (imported ${cacheRetrieve.template.importedCount.toString()}x)`,
      `Durata: ${cachedDurationMs.toString()}ms (zero LLM call)`,
      `Nodi: ${cachedWf.nodes.length.toString()}, edges: ${cachedWf.edges.length.toString()}`,
      'Workflow NON ancora salvato — rivedi e premi "Importa" per confermare.',
    ],
  };
  // Bump imported_count via save (idempotent on signature)
  try {
    templateCache.save({
      promptText: goal,
      workflow: { name: cachedWf.name, nodes: cachedWf.nodes.map((n) => ({ id: n.id, defId: n.defId })), edges: cachedWf.edges.map((e) => ({ from: e.from, to: e.to })) },
      workflowJson: cacheRetrieve.template.workflowJson,
    });
  } catch { /* non-fatal */ }
  return cachedResult;
}
