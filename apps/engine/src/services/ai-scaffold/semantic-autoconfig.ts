/**
 * semantic-autoconfig — AUTO-CONFIG DETERMINISTICA (#8).
 *
 * "Il modello propone la struttura, il codice riempie la meccanica."
 * La grammatica vincolata (constrained-schema) garantisce che defId/chiavi/enum
 * siano STRUTTURALMENTE validi, ma NON la completezza semantica (un required
 * omesso, un enum scritto con case sbagliato). Qui il CODICE — non l'LLM —
 * completa ciò che è deterministico:
 *
 *   1. fill_default     — riempie i campi mancanti dal `defaultValue` del NodeDef
 *                         (mai i secret = pending). Evita 502 per omissioni di
 *                         campi che hanno un default sensato.
 *   2. normalize_enum   — un valore enum giusto ma con case sbagliato ("get" →
 *                         "GET") viene normalizzato al valore canonico.
 *
 * Trasformazioni SOLO safe e behavior-preserving: il default è il valore che il
 * nodo userebbe comunque; la normalizzazione case non cambia la scelta, la
 * rende valida. Le espressioni `{{ }}` non vengono MAI toccate. Niente LLM.
 *
 * Ciò che NON è deterministico (un required di contenuto senza default, es.
 * `url`) resta al validatore → loop di riparazione (semantic-repair).
 *
 * @module services/ai-scaffold/semantic-autoconfig
 */
import { isExpressionValue, type ConfigKeySpec, type NodeConfigSpec } from '@/services/ai-scaffold/catalog-spec.js';

export interface AutoConfigNode {
  id: string;
  defId: string;
  config?: Record<string, unknown>;
}

export interface AutoConfigFix {
  kind: 'fill_default' | 'normalize_enum';
  nodeId: string;
  defId: string;
  key: string;
  /** Valore impostato dalla fix. */
  value: unknown;
  /** Valore precedente (solo normalize_enum). */
  previous?: unknown;
}

export interface AutoConfigResult<N extends AutoConfigNode> {
  nodes: N[];
  applied: AutoConfigFix[];
}

/** Un valore di config "mancante"? (assente/null/'' → da riempire col default). */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Coerce il `defaultValue` (stringa del NodeDef) al tipo del campo. */
function coerceDefault(raw: string, spec: ConfigKeySpec): unknown {
  if (spec.kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (spec.kind === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  return raw; // enum/string/structured → stringa così com'è
}

/** Mappa case-insensitive valore→opzione canonica per i campi enum. */
function canonicalEnum(value: string, options: string[]): string | null {
  const lower = value.toLowerCase();
  for (const opt of options) {
    if (opt.toLowerCase() === lower) return opt;
  }
  return null;
}

/**
 * Applica le fix deterministiche a un workflow scaffold. Ritorna NUOVI nodi
 * (config clonata, non muta l'input) + la lista delle fix applicate.
 * I nodi con defId sconosciuto (non nello spec) vengono lasciati intatti — la
 * loro validità è competenza del validatore/repair, non dell'auto-config.
 */
export function applyDeterministicAutoConfig<N extends AutoConfigNode>(
  nodes: N[],
  spec: Map<string, NodeConfigSpec>,
): AutoConfigResult<N> {
  const applied: AutoConfigFix[] = [];
  const out = nodes.map((node) => {
    const nodeSpec = spec.get(node.defId);
    if (!nodeSpec) return node; // defId sconosciuto → intatto
    const config: Record<string, unknown> = { ...(node.config ?? {}) };

    // 1. fill_default — riempi i campi mancanti che hanno un default (no secret).
    for (const keySpec of nodeSpec.keys.values()) {
      if (keySpec.secret || keySpec.defaultValue === undefined) continue;
      if (!isMissing(config[keySpec.key])) continue;
      const value = coerceDefault(keySpec.defaultValue, keySpec);
      config[keySpec.key] = value;
      applied.push({ kind: 'fill_default', nodeId: node.id, defId: node.defId, key: keySpec.key, value });
    }

    // 2. normalize_enum — case-fix di un valore enum altrimenti corretto.
    for (const keySpec of nodeSpec.keys.values()) {
      if (keySpec.kind !== 'enum' || !keySpec.options) continue;
      const value = config[keySpec.key];
      if (typeof value !== 'string' || isExpressionValue(value)) continue;
      if (keySpec.options.includes(value)) continue; // già canonico
      const canon = canonicalEnum(value, keySpec.options);
      if (canon !== null) {
        config[keySpec.key] = canon;
        applied.push({ kind: 'normalize_enum', nodeId: node.id, defId: node.defId, key: keySpec.key, value: canon, previous: value });
      }
    }

    return { ...node, config };
  });

  return { nodes: out, applied };
}
