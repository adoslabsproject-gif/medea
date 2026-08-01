/**
 * Transpiler di espressioni n8n → FlowForge.
 *
 * In n8n un valore di parametro è un'ESPRESSIONE quando inizia con `=` (es.
 * `"=https://api.com/{{ $json.id }}"`). Dentro `{{ }}` la sintassi differisce:
 *   - n8n:       $json["key"], $node["Nome Nodo"].json.x, $json.x, $now, $today
 *   - FlowForge: $json.key,     $node.<id>.json.x,         $json.x, $now, $today
 *
 * Questo modulo converte la sintassi. Senza, ogni espressione importata da n8n è
 * rotta (riferimenti per NOME nodo + accesso a bracket + leading `=`).
 *
 * Helper supportati in FlowForge: $json, $node, $now, $today, $vars, $input.
 * Gli helper n8n SENZA equivalente ($items, $workflow, $execution, $runIndex,
 * $itemIndex, $binary, $prevNode, $parameter) NON sono convertibili: vengono lasciati
 * e segnalati nei warning, così l'utente sa cosa adattare a mano (onestà > magia finta).
 *
 * Pure, deterministico, no I/O.
 */

export interface TranspileResult {
  value: string;
  /** avvisi non-fatali (nodo non trovato, helper non supportato) — deduplicati. */
  warnings: string[];
}

/** Helper n8n senza equivalente FlowForge: non convertibili, solo segnalabili. */
const UNSUPPORTED_HELPERS = [
  '$items', '$workflow', '$execution', '$runIndex', '$itemIndex', '$binary', '$prevNode', '$parameter',
] as const;

/**
 * Converte un singolo valore di parametro n8n in un valore FlowForge.
 * - Valore NON espressione (no leading `=`) → restituito invariato (semantica n8n:
 *   `{{ }}` senza `=` è testo letterale, non un'espressione).
 * - Valore espressione (`=...`) → strip del `=` + conversione di ogni blocco `{{ }}`.
 */
export function transpileN8nExpression(raw: string, nodeNameToId: ReadonlyMap<string, string>): TranspileResult {
  const warnings: string[] = [];
  if (!raw.startsWith('=')) return { value: raw, warnings };

  const body = raw.slice(1); // strip del marcatore espressione n8n
  const value = body.replace(/\{\{([\s\S]*?)\}\}/g, (_match, innerRaw: string) => {
    let e = innerRaw.trim();

    // $node["Nome Nodo"] / $node['..'] / $node[`..`] → $node.<id-FlowForge>
    e = e.replace(/\$node\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g, (_m, name: string) => {
      const id = nodeNameToId.get(name);
      if (id) return `$node.${id}`;
      warnings.push(`nodo "${name}" non trovato nel workflow — riferimento da sistemare a mano`);
      return `$node.${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    });

    // accesso bracket a chiave QUOTATA semplice → dot-notation: ["key"] → .key
    // (gli indici numerici [0] e le chiavi con spazi restano bracket: non dot-izzabili)
    e = e.replace(/\[\s*['"`]([a-zA-Z_$][\w$]*)['"`]\s*\]/g, '.$1');

    for (const h of UNSUPPORTED_HELPERS) {
      if (e.includes(h)) warnings.push(`helper "${h}" non ha equivalente FlowForge — adatta a mano`);
    }
    return `{{${e}}}`;
  });

  return { value, warnings: [...new Set(warnings)] };
}

/**
 * Applica il transpiler a TUTTI i valori stringa di un oggetto config (1 livello),
 * accumulando i warning. I valori non-stringa restano invariati.
 */
export function transpileConfigExpressions(
  config: Record<string, string>,
  nodeNameToId: ReadonlyMap<string, string>,
): { config: Record<string, string>; warnings: string[] } {
  const out: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    const r = transpileN8nExpression(v, nodeNameToId);
    out[k] = r.value;
    for (const w of r.warnings) warnings.push(`${k}: ${w}`);
  }
  return { config: out, warnings };
}
