/**
 * make-llm-repair — costruisce una RepairFn basata su LLM (#8 strato B).
 *
 * La chiamata strutturata (`dispatch`) è INIETTATA → testabile senza modello
 * reale e provider-agnostica. In produzione `dispatch` avvolge
 * `dispatchLLMChatStructured` (guided_json) col provider risolto del tenant.
 *
 * Fail-soft: qualunque errore (LLM giù, JSON illeggibile) → ritorna [] e il loop
 * di riparazione si ferma con le violazioni residue (il caller decide il 502 coi
 * messaggi precisi del validatore). MAI lancia.
 *
 * @module services/ai-scaffold/make-llm-repair
 */
import { logger } from '@/lib/logger.js';
import { buildRepairPrompt } from '@/services/ai-scaffold/repair-prompt.js';
import type { RepairFn, RepairedNode } from '@/services/ai-scaffold/semantic-repair.js';

/** Chiamata LLM strutturata: prompt + schema → testo JSON. */
export type StructuredDispatch = (args: { system: string; user: string; schema: object }) => Promise<string>;

export interface MakeLlmRepairOptions {
  dispatch: StructuredDispatch;
  goal?: string;
}

/** Estrae l'array `fixes` da una risposta LLM (fenced o raw), fail-soft. */
function parseFixes(raw: string): RepairedNode[] {
  const fence = /```json\s*([\s\S]*?)\s*```/.exec(raw);
  const jsonText = (fence?.[1] ?? raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const fixes = (parsed as { fixes?: unknown }).fixes;
  if (!Array.isArray(fixes)) return [];
  const out: RepairedNode[] = [];
  for (const f of fixes) {
    if (typeof f !== 'object' || f === null) continue;
    const id = (f as { id?: unknown }).id;
    const config = (f as { config?: unknown }).config;
    if (typeof id === 'string' && id.length > 0 && typeof config === 'object' && config !== null && !Array.isArray(config)) {
      out.push({ id, config: config as Record<string, unknown> });
    }
  }
  return out;
}

/** Crea una RepairFn che chiede all'LLM di correggere i nodi rotti. */
export function makeLlmRepairFn(opts: MakeLlmRepairOptions): RepairFn {
  return async ({ nodes, violations }) => {
    const promptInput = { nodes, violations, ...(opts.goal ? { goal: opts.goal } : {}) };
    const { system, user, schema } = buildRepairPrompt(promptInput);
    try {
      const raw = await opts.dispatch({ system, user, schema });
      const fixes = parseFixes(raw);
      logger.info({ violations: violations.length, fixes: fixes.length }, '[SEMANTIC-REPAIR] LLM repair round');
      return fixes;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[SEMANTIC-REPAIR] LLM repair failed (soft) → nessuna fix');
      return [];
    }
  };
}
