/**
 * Logic Merge executor — combina output di multi-branch upstream nodes.
 *
 * Pattern enterprise:
 *   Quando un workflow ha N nodi paralleli che convergono in 1, il merge
 *   raccoglie i loro output e li combina secondo strategia configurabile.
 *
 * STRATEGIE:
 *   - 'all' (default): aspetta tutti i branch, ritorna `branches: {id: output}`
 *   - 'concat-arrays': come 'all', ma se ogni branch ha output.results[]
 *     concatena gli array in 1 unico { results: [...] } (use case: 3 search
 *     → 60 result items unificati)
 *   - 'any': prende il primo branch che ha output (idx più basso)
 *   - 'first'/'last': come 'any' ma esplicito
 *
 * INPUT discovery:
 *   L'engine garantisce che `input` è già l'output del nodo immediatamente
 *   precedente nel grafo. Per multi-branch, dobbiamo cercare in
 *   `context.nodeOutputs` (popolato dall'engine) gli output di TUTTI i nodi
 *   upstream (edges where target == this node).
 *
 *   Non possiamo accedere a edge metadata da qui, quindi facciamo discovery
 *   euristico: prendi tutti i nodeOutputs che non sono il nostro stesso
 *   nodeId e che hanno status success (escludiamo i predecessor del merge
 *   downstream — l'engine ce li passa già filtered).
 *
 *   Soluzione robusta: configFields permette di specificare esplicitamente
 *   i sourceNodeIds (CSV) — se vuoto, prende TUTTI i nodeOutputs presenti
 *   (cui ovviamente sono solo i branch parallel completed prima del merge).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';

interface BranchOutput {
  nodeId: string;
  output: unknown;
}

function gatherBranches(
  config: Record<string, unknown>,
  nodeOutputs: Record<string, unknown>,
): BranchOutput[] {
  const sourcesRaw = coerceString(config.sourceNodeIds ?? '').trim();
  const sourceIds = sourcesRaw
    ? sourcesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : Object.keys(nodeOutputs);
  return sourceIds
    .map((nodeId) => {
      const wrapped = nodeOutputs[nodeId] as { json?: unknown } | undefined;
      if (wrapped && typeof wrapped === 'object' && 'json' in wrapped) {
        return { nodeId, output: wrapped.json };
      }
      return { nodeId, output: wrapped };
    })
    .filter((b) => b.output !== undefined);
}

export const logicMergeExecutor: NodeExecutor = (config, _input, context) => {
  const start = Date.now();
  const strategy = coerceString(config.strategy ?? 'all').toLowerCase();
  const nodeOutputs = context.nodeOutputs ?? {};
  const branches = gatherBranches(config, nodeOutputs);

  let output: unknown;

  switch (strategy) {
    case 'concat-arrays': {
      // Pattern: 3 search → cada branch ha output.results[]. Concateniamo i results.
      const all: unknown[] = [];
      const arrayProperty = coerceString(config.arrayProperty ?? 'results').trim() || 'results';
      for (const b of branches) {
        const obj = b.output as Record<string, unknown> | undefined;
        const arr = obj && typeof obj === 'object' ? obj[arrayProperty] : undefined;
        if (Array.isArray(arr)) {
          for (const item of arr) all.push(item);
        } else if (Array.isArray(b.output)) {
          // Caso B: branch è già un array (no property name)
          for (const item of b.output) all.push(item);
        }
      }
      output = { [arrayProperty]: all, branchCount: branches.length, totalItems: all.length };
      break;
    }
    case 'any':
    case 'first': {
      output = branches[0]?.output ?? null;
      break;
    }
    case 'last': {
      output = branches[branches.length - 1]?.output ?? null;
      break;
    }
    case 'all':
    default: {
      // Default: ritorna mappa { branches: {nodeId: output, ...} }
      // Object.create(null): un nodeId `__proto__`/`constructor` come chiave NON deve
      // alterare il prototype dell'oggetto (prototype pollution). Con prototype null,
      // `map['__proto__'] = x` diventa una normale own-property, innocua.
      const branchesMap: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const b of branches) branchesMap[b.nodeId] = b.output;
      output = { branches: branchesMap, branchCount: branches.length };
      break;
    }
  }

  return Promise.resolve({
    output,
    durationMs: Date.now() - start,
  });
};
