/**
 * Template feedback — il pezzo che chiudeva il cerchio run→template→ranking.
 *
 * `templateCache.recordOutcome` esisteva ("rank boost/penalty sui run reali")
 * ma NESSUNO lo chiamava: il sistema non imparava se i workflow generati poi
 * GIRAVANO davvero. Questo modulo lo aggancia alla fine di ogni run:
 *
 *   run completato → computeGraphSignature(workflow eseguito)
 *                  → match col template (stessa struttura)
 *                  → success_count/fail_count → successRate nel retrieve score.
 *
 * Matching STRUTTURALE (graph signature): zero modifiche allo schema Workflow,
 * zero campi da trascinare nell'import. Se l'utente modifica il workflow dopo
 * l'import la signature diverge → niente outcome: onesto, non è più il
 * template. Fail-soft totale: il feedback è best-effort e non deve MAI
 * toccare l'esito del run.
 */
import { computeGraphSignature } from '@/services/ai-scaffold/template-cache/signature.js';
import { templateCache } from '@/services/ai-scaffold/template-cache/template.service.js';
import { logger } from '@/lib/logger.js';

export function recordRunOutcomeForTemplate(
  workflow: {
    nodes: readonly { id: string; defId: string }[];
    edges: readonly { from: string; to: string }[];
  },
  ok: boolean,
): void {
  try {
    const signature = computeGraphSignature(workflow.nodes, workflow.edges);
    const templateId = templateCache.findIdBySignature(signature);
    if (!templateId) return; // workflow non nato da template (o modificato): niente da imparare qui
    templateCache.recordOutcome(templateId, ok);
    logger.debug({ templateId, ok }, '[template-feedback] run outcome registrato sul template');
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, '[template-feedback] failed (fail-soft)');
  }
}
