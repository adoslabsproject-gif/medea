/**
 * Domain — DetectedRow.
 *
 * Una riga identificata come corrotta dalla `detect()` di una regola.
 * Immutabile. Tutti i campi `Readonly`. Il framework non muta mai questi
 * oggetti — al massimo li copia.
 */

import { type CorruptionSeverity } from './severity.js';

export interface DetectedRow {
  /**
   * Primary key della riga sulla tabella live. Sempre stringificato
   * (anche per PK numerici/UUID) — il framework non interpreta il
   * formato, lo conserva tale-quale per quarantine/restore.
   */
  readonly id: string;
  /** Tenant proprietario, se applicabile. Undefined per tabelle global. */
  readonly tenantId?: string;
  /** Spiegazione human-readable, mostrata in UI e audit. Italiano. */
  readonly reason: string;
  readonly severity: CorruptionSeverity;
  /**
   * Dump COMPLETO della riga originale. Salvato in `quarantined_rows.raw_json`
   * per quarantine + futuro restore. Deve contenere TUTTE le colonne
   * della tabella live (no proiezioni parziali — il restore le richiede).
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Builder helper — evita di scrivere `as const` o `Object.freeze()` su
 * ogni costruzione. Restituisce un oggetto frozen.
 */
export function buildDetectedRow(args: {
  id: string;
  reason: string;
  severity: CorruptionSeverity;
  raw: Record<string, unknown>;
  tenantId?: string;
}): DetectedRow {
  const out: DetectedRow =
    args.tenantId !== undefined
      ? {
          id: args.id,
          reason: args.reason,
          severity: args.severity,
          raw: Object.freeze({ ...args.raw }),
          tenantId: args.tenantId,
        }
      : {
          id: args.id,
          reason: args.reason,
          severity: args.severity,
          raw: Object.freeze({ ...args.raw }),
        };
  return Object.freeze(out);
}
