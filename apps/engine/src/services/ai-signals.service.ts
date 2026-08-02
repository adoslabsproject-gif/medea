/**
 * AISignalsService — Track A del capture AI: segnale AGGREGATO/STRUTTURALE
 * NON-personale, SEMPRE attivo (nessun consenso necessario).
 *
 * ⚖️ Confine legale (blindato dal guard `ai-signals-no-freetext.guard.test.ts`):
 * qui NON entra MAI testo libero (prompt/risposta), PII o quasi-identificatori —
 * solo metadati operativi: tipo interazione, nodeDef proposto, modello, latenza,
 * token, esito (accepted/rejected/…), quality. Restando non-personale è fuori dal
 * GDPR → si può raccogliere senza opt-in, a differenza di Track B (ai_interactions,
 * testo grezzo opt-in). Vedi `ai-interactions.service.ts`.
 *
 * Fail-soft come Track B: un errore di capture NON deve MAI rompere la richiesta AI.
 *
 * @module services/ai-signals.service
 */
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/storage/db.js';
import { loggerFor } from '@/lib/logger.js';

const log = loggerFor('ai-signals');

export type SignalInteractionType =
  | 'editor_chat'
  | 'run_explain'
  | 'node_generate'
  | 'workflow_from_text';
export type SignalOutcome = 'pending' | 'accepted' | 'rejected' | 'edited' | 'ignored' | 'failed';

export interface RecordSignalArgs {
  /** Condiviso con ai_interactions quando il tenant è opt-in; altrimenti interno. */
  id?: string;
  tenantId: string;
  interactionType: SignalInteractionType;
  /** NodeDef proposto (strutturale, non-personale) o null. */
  nodeDefId?: string | null;
  model: string;
  latencyMs: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface SignalStats {
  total: number;
  byOutcome: Record<string, number>;
  byInteractionType: Record<string, number>;
}

export class AISignalsService {
  /**
   * Registra un segnale non-personale. SEMPRE invocato (prima del gate opt-in di
   * Track B). Ritorna l'id (generato se non passato). Idempotente sull'id
   * (ON CONFLICT DO NOTHING) e fail-soft.
   */
  record(args: RecordSignalArgs): string {
    const id = args.id ?? randomUUID();
    try {
      const { sqlite } = getDatabase();
      sqlite
        .prepare(
          `
          INSERT INTO ai_signals (
            id, tenant_id, interaction_type, node_def_id,
            response_model, response_latency_ms, response_tokens_in, response_tokens_out
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `,
        )
        .run(
          id,
          args.tenantId,
          args.interactionType,
          args.nodeDefId ?? null,
          args.model,
          args.latencyMs,
          args.tokensIn ?? null,
          args.tokensOut ?? null,
        );
    } catch (err) {
      log.error(
        { err, tenantId: args.tenantId, interactionType: args.interactionType },
        'ai_signals record failed',
      );
    }
    return id;
  }

  /** Aggiorna l'esito (accepted/rejected/…). Tenant-scoped, fail-soft. */
  updateOutcome(id: string, tenantId: string, outcome: SignalOutcome): boolean {
    try {
      const { sqlite } = getDatabase();
      const res = sqlite
        .prepare(
          `
          UPDATE ai_signals
          SET outcome = ?, outcome_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND tenant_id = ?
        `,
        )
        .run(outcome, id, tenantId);
      return res.changes > 0;
    } catch (err) {
      log.error({ err, tenantId }, 'ai_signals updateOutcome failed');
      return false;
    }
  }

  /** Riflette il quality score della review nel segnale aggregato. Fail-soft. */
  updateQuality(id: string, tenantId: string, qualityScore: number): boolean {
    try {
      const { sqlite } = getDatabase();
      const res = sqlite
        .prepare('UPDATE ai_signals SET quality_score = ? WHERE id = ? AND tenant_id = ?')
        .run(qualityScore, id, tenantId);
      return res.changes > 0;
    } catch (err) {
      log.error({ err, tenantId }, 'ai_signals updateQuality failed');
      return false;
    }
  }

  /** Aggregati per-tenant (non-personali) per dashboard/analytics. */
  stats(tenantId: string): SignalStats {
    const { sqlite } = getDatabase();
    const total = (
      sqlite.prepare('SELECT COUNT(*) AS c FROM ai_signals WHERE tenant_id = ?').get(tenantId) as {
        c: number;
      }
    ).c;
    const byOutcome: Record<string, number> = {};
    for (const r of sqlite
      .prepare('SELECT outcome, COUNT(*) AS c FROM ai_signals WHERE tenant_id = ? GROUP BY outcome')
      .all(tenantId) as { outcome: string; c: number }[]) {
      byOutcome[r.outcome] = r.c;
    }
    const byInteractionType: Record<string, number> = {};
    for (const r of sqlite
      .prepare(
        'SELECT interaction_type, COUNT(*) AS c FROM ai_signals WHERE tenant_id = ? GROUP BY interaction_type',
      )
      .all(tenantId) as { interaction_type: string; c: number }[]) {
      byInteractionType[r.interaction_type] = r.c;
    }
    return { total, byOutcome, byInteractionType };
  }
}
