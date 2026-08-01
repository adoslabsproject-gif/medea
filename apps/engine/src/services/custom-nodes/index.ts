/**
 * Custom Node Editor — barrel export.
 *
 * Entry point pubblico per il modulo `services/custom-nodes`.
 * Consumer (routes/custom-nodes.ts, LSP server, AI assist proxy) importano da qui.
 *
 * @module services/custom-nodes
 */

export * from './types.js';
export * from './errors.js';
export {
  createCustomNode,
  getCustomNode,
  getCustomNodeBySlug,
  listCustomNodes,
  listCustomNodeDefinitions,
  updateCustomNode,
  listVersions,
  rollbackToVersion,
  archiveCustomNode,
  persistCompileResult,
  appendTestRun,
  listTestRuns,
  bumpSemver,
  publishCustomNodePrivate,
  unpublishCustomNode,
  submitCustomNodeToMarketplace,
  withdrawCustomNodeFromMarketplace,
  customNodeDefId,
} from './service.js';
export {
  loadCustomNodeForRun,
  parseCustomDefId,
} from './runtime-loader.js';
export {
  onCustomNodeUpdate,
  emitCustomNodeUpdate,
  invalidateCustomNode,
  invalidateAllCustomNodes,
  customNodeCacheSize,
  type CompiledCustomNodeEntry,
  type CustomNodeUpdateEvent,
} from './cache.js';
export {
  compileCustomNodeSources,
  compileAndPersist,
  securityScan,
} from './compile.service.js';
export {
  PLAN_CAPABILITIES,
  resolveTenantPlan,
  countActiveCustomNodes,
  assertCanCreateMoreCustomNodes,
  assertCanPublishMarketplace,
  type PlanCode,
  type PlanCapability,
} from './plan-gating.js';
