/**
 * Aggregation primitives — riduce una collection PRIMA di iterare.
 *
 * Pattern enterprise:
 *
 *   trigger (50k orders)
 *     → group_by(customer_id)           [50k → 200 groups]
 *     → aggregate(sum, total)           [200 groups, each with sum]
 *     → loop strategy=bulk              [1 bulk API call]
 *
 *   vs. naive:
 *   trigger (50k orders) → loop strategy=naive   [50k iterations, 5h]
 *
 * Stesso outcome business, 2500× piu\` veloce.
 */

export { groupByNode } from './group-by.js';
export { aggregateNode } from './aggregate.js';
export { distinctNode } from './distinct.js';
export { windowNode } from './window.js';
export { getField, toNumber, normalizeItems } from './helpers.js';
