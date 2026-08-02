/**
 * Custom Node Editor — plan-tier gating + quota enforcement.
 *
 * Plan quota (allineato a docs/CUSTOM-NODE-EDITOR-2026.md):
 *   free       → 0 custom nodes (sees "upgrade for custom nodes" CTA)
 *   starter    → 3 custom nodes, no marketplace publish
 *   pro        → 20 custom nodes + marketplace submit (admin review obbligatoria)
 *   business   → 100 custom nodes + marketplace auto-publish (security scan green)
 *   team       → 100 custom nodes + same as business
 *   enterprise → unlimited + private dedicated registry
 *
 * Plan code source: env `MEDEA_PLAN_CODE` settata da onboarding.ts buildEnv
 * del portal quando crea/aggiorna il container tenant (cambio piano = recreate).
 *
 * Per il quota check: leggiamo il counter attuale da `custom_nodes` WHERE
 * status != 'archived', e confrontiamo con il limit del piano.
 *
 * @module services/custom-nodes/plan-gating
 */

import { CustomNodeQuotaExceededError, CustomNodeForbiddenError } from './errors.js';
import { getDatabase } from '@/storage/db.js';
import { customNodes } from '@/storage/schema.js';
import { sql, and, eq, ne } from 'drizzle-orm';

export type PlanCode = 'free' | 'starter' | 'pro' | 'business' | 'team' | 'enterprise';

export interface PlanCapability {
  /** Max custom_nodes per tenant (non-archived). null = illimitati. */
  maxCustomNodes: number | null;
  /** Può submittare al marketplace pubblico. */
  canPublishMarketplace: boolean;
  /** Auto-publish se security scan green (admin post-review). */
  marketplaceAutoPublish: boolean;
  /** Liara AI token quota mensile per tenant (per il sidebar Genera con AI). */
  aiTokenQuotaMonthly: number;
}

export const PLAN_CAPABILITIES: Record<PlanCode, PlanCapability> = {
  free: {
    maxCustomNodes: 0,
    canPublishMarketplace: false,
    marketplaceAutoPublish: false,
    aiTokenQuotaMonthly: 0,
  },
  starter: {
    maxCustomNodes: 3,
    canPublishMarketplace: false,
    marketplaceAutoPublish: false,
    aiTokenQuotaMonthly: 50_000,
  },
  pro: {
    maxCustomNodes: 20,
    canPublishMarketplace: true,
    marketplaceAutoPublish: false,
    aiTokenQuotaMonthly: 500_000,
  },
  business: {
    maxCustomNodes: 100,
    canPublishMarketplace: true,
    marketplaceAutoPublish: true,
    aiTokenQuotaMonthly: 5_000_000,
  },
  team: {
    maxCustomNodes: 100,
    canPublishMarketplace: true,
    marketplaceAutoPublish: true,
    aiTokenQuotaMonthly: 5_000_000,
  },
  enterprise: {
    maxCustomNodes: null,
    canPublishMarketplace: true,
    marketplaceAutoPublish: true,
    aiTokenQuotaMonthly: Number.MAX_SAFE_INTEGER,
  },
};

/**
 * Risolve il plan code corrente del tenant dall'env del container.
 * Default 'free' se mancante.
 */
export function resolveTenantPlan(): PlanCode {
  const raw = process.env.MEDEA_PLAN_CODE?.trim().toLowerCase() ?? 'free';
  if (raw in PLAN_CAPABILITIES) return raw as PlanCode;
  // Fallback safe se env malformato — log per debug
  return 'free';
}

/**
 * Conta i custom_nodes NON archived nel tenant attuale.
 * Single SQLite tenant = single workspace, ma WHERE workspace_id per defensive
 * coding (esiste sempre il caso di test/multi-tenant DB).
 */
export async function countActiveCustomNodes(workspaceId: string): Promise<number> {
  const handle = getDatabase();
  const result = (await handle.sqlite
    .prepare(
      `SELECT COUNT(*) AS cnt FROM custom_nodes
      WHERE workspace_id = ? AND status != 'archived'`,
    )
    .get(workspaceId)) as { cnt: number } | undefined;
  return result?.cnt ?? 0;
}

/**
 * Enforce quota BEFORE create. Throws CustomNodeQuotaExceededError se >= limit.
 * Suggerisce il piano successivo nel messaggio errore (UX-friendly).
 */
export async function assertCanCreateMoreCustomNodes(workspaceId: string): Promise<void> {
  const plan = resolveTenantPlan();
  const cap = PLAN_CAPABILITIES[plan];
  if (cap.maxCustomNodes === null) return; // unlimited (enterprise)
  const current = await countActiveCustomNodes(workspaceId);
  if (current < cap.maxCustomNodes) return;
  const sugg = suggestUpgrade(plan);
  throw new CustomNodeQuotaExceededError({
    current,
    limit: cap.maxCustomNodes,
    planCode: plan,
    ...(sugg ? { suggestedPlan: sugg } : {}),
  });
}

/**
 * Enforce gating per publish-marketplace. Pro+ ammessi (review obbligatoria).
 * Starter/Free → ForbiddenError.
 */
export function assertCanPublishMarketplace(): void {
  const plan = resolveTenantPlan();
  const cap = PLAN_CAPABILITIES[plan];
  if (!cap.canPublishMarketplace) {
    throw new CustomNodeForbiddenError(
      `Marketplace publish requires plan Pro or higher (current: "${plan}"). ` +
        `Suggested upgrade: "${suggestUpgrade(plan)}".`,
    );
  }
}

/** Suggest the next plan tier (UX message). */
function suggestUpgrade(current: PlanCode): string | undefined {
  const order: PlanCode[] = ['free', 'starter', 'pro', 'business', 'team', 'enterprise'];
  const idx = order.indexOf(current);
  if (idx < 0 || idx >= order.length - 1) return undefined;
  return order[idx + 1];
}

// Suppress unused: imports tenuti per export-readiness future query Drizzle
void customNodes;
void and;
void eq;
void ne;
void sql;
