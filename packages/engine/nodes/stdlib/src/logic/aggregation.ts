/**
 * Aggregation primitives — re-export back-compat.
 *
 * L'implementazione e\` stata refactored in `./aggregation/` (v1.1):
 *   • helpers.ts   — getField / toNumber / normalizeItems shared
 *   • group-by.ts  — groupByNode
 *   • aggregate.ts — aggregateNode (Strategy pattern per i 6 reducer)
 *   • distinct.ts  — distinctNode
 *   • window.ts    — windowNode (time-bucket ISO)
 *
 * Questo file resta come entry-point storico — i consumer che importano
 * `logic/aggregation.js` continuano a vedere gli stessi NodeModule.
 */

export {
  groupByNode,
  aggregateNode,
  distinctNode,
  windowNode,
  getField,
  toNumber,
  normalizeItems,
} from './aggregation/index.js';
