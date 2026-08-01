/**
 * Post-processing self-healing del workflow generato — estratto da singleshot
 * (split NO-MONOLITI 2026-06-11). È l'AUTOMAZIONE: dopo che la LLM genera, il
 * sistema RIPARA i bug deterministici prima di consegnare il workflow.
 *
 * Orchestrazione IMPURA (muta il workflow, logga, throwa per il retry) che usa i
 * moduli PURI sottostanti (requirement-coverage.ts, dataflow-validator.ts) — così
 * quelli restano testabili in isolamento e qui sta solo il collante.
 *
 *  - applyReachabilityHeal       collega i nodi referenziati ma non a monte (edge)
 *  - enforceCoverageAndInject    reject+retry se manca una capability richiesta;
 *                                all'ultimo tentativo la INIETTA invece di avvisare
 */
import { AiScaffoldError } from '@/services/ai-scaffold/types.js';
import { extractMissingCapabilities, buildCoverageFeedback, buildCapabilityInjection } from '@/services/ai-scaffold/requirement-coverage.js';
import { healDataflowReachability } from '@/services/ai-scaffold/dataflow-validator.js';
import { logger } from '@/lib/logger.js';

/** Forma minima mutabile del workflow parsed (compatibile con z.infer ZodOutputShape;
 *  gli opzionali sono `| undefined` perché z.infer li rende tali con
 *  exactOptionalPropertyTypes). */
export interface PpWorkflow {
  nodes: { id: string; defId: string; label?: string | undefined; x?: number | undefined; y?: number | undefined; config: Record<string, unknown> }[];
  edges: { from: string; to: string; fromPort?: string | undefined }[];
}

/**
 * AUTO-HEAL DATA-FLOW: se la LLM ha referenziato `$node.X.json` ma X non è
 * collegato a monte (bug reachability IMAP CRM), COLLEGA X → il nodo che lo usa
 * così il dato fluisce. Deterministico + cycle-safe. Muta wf.edges in place.
 */
export function applyReachabilityHeal(wf: PpWorkflow): void {
  const reachabilityEdges = healDataflowReachability(
    wf.nodes.map((n) => ({ id: n.id, defId: n.defId, config: n.config })),
    wf.edges.map((e) => ({ from: e.from, to: e.to })),
  );
  if (reachabilityEdges.length > 0) {
    for (const e of reachabilityEdges) wf.edges.push(e);
    logger.info({ healed: reachabilityEdges.length, edges: reachabilityEdges }, '[SINGLESHOT] data-flow reachability HEALED (edge mancanti aggiunti)');
  }
}

/**
 * REQUIREMENT-COVERAGE ENFORCEMENT — il workflow deve FARE quello che è chiesto.
 * Se il prompt richiede una capability con un nodo reale (grafico→chart, confronto
 * storico→db_query) ma il workflow non la copre:
 *  - NON ultimo tentativo → throw AiScaffoldError (il retry rigenera con feedback);
 *  - ultimo tentativo → INIETTA deterministicamente ogni nodo mancante, cablato sul
 *    terminale originale (fan-out) → "l'ho fatto io per te", non un warning.
 * Muta wf in place. Ritorna i warning di coverage (per le note).
 */
export function enforceCoverageAndInject(wf: PpWorkflow, goal: string, isLastAttempt: boolean): string[] {
  const coverageWarnings: string[] = [];
  const missingCaps = extractMissingCapabilities(goal, wf.nodes.map((n) => n.defId));
  if (missingCaps.length === 0) return coverageWarnings;

  if (!isLastAttempt) {
    logger.warn({ missing: missingCaps.map((m) => m.id), goal: goal.slice(0, 200) }, '[SINGLESHOT] requirement-coverage reject → retry');
    throw new AiScaffoldError(buildCoverageFeedback(missingCaps), 502);
  }

  // Snapshot ORIGINALE così tutti gli iniettati si agganciano al terminale
  // originale (fan-out), non in catena tra loro.
  const origNodes = wf.nodes.map((n) => ({ id: n.id, defId: n.defId }));
  const origEdges = wf.edges.map((e) => ({ from: e.from, to: e.to }));
  for (const cap of missingCaps) {
    const inj = buildCapabilityInjection(cap.id, origNodes, origEdges);
    if (inj) {
      wf.nodes.push({ id: inj.node.id, defId: inj.node.defId, config: inj.node.config });
      if (inj.edge) wf.edges.push(inj.edge);
      logger.info({ injected: inj.node.defId, cap: cap.id }, '[SINGLESHOT] requirement-coverage: nodo INIETTATO automaticamente (last-attempt)');
      coverageWarnings.push(`✨ Aggiunto automaticamente \`${inj.node.defId}\` (richiesto: ${cap.label}) — rivedi/personalizza la config.`);
    } else {
      // Solo se il workflow è vuoto (niente a cui agganciare) → impossibile iniettare.
      logger.warn({ cap: cap.id }, '[SINGLESHOT] requirement-coverage: nessun nodo a cui agganciare l\'inject');
      coverageWarnings.push(`⚠️ Richiesto ma MANCANTE: ${cap.label} — aggiungi il nodo \`${cap.suggestNode}\` nell'editor.`);
    }
  }
  return coverageWarnings;
}
