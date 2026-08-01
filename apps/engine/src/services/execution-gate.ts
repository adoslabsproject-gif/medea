/**
 * Execution gate — billing/lifecycle alla RADICE dell'esecuzione workflow.
 *
 * Il middleware HTTP `tenantStatusMiddleware` copre solo le route mutative e
 * ha in skip-list `/api/v1/webhooks` → trigger automatici (cron/scheduler/
 * watcher) e webhook esterni NON passano da lì e, a trial scaduto, eseguirebbero
 * comunque. Questo gate va chiamato nel punto dove OGNI run parte
 * (run.service.execute / startAsync) → un solo punto, zero buchi.
 *
 * Politica FAIL-OPEN (deliberata, billing-safe):
 *   - BLOCCA il run SOLO quando è CERTO che il tenant non è operativo, cioè
 *     `assertActive` lancia `TenantNotActiveError` (trial scaduto / suspended /
 *     archived). L'utente mantiene editor/dati (le letture GET non sono gated).
 *   - QUALSIASI altro esito (tenant non in tabella, DB non disponibile, errore
 *     imprevisto del gate) → PASSA. Bloccare l'esecuzione di clienti paganti
 *     per un errore infrastrutturale del gate sarebbe molto peggio che lasciar
 *     passare un caso limite: il gate non deve mai essere un single-point of
 *     failure per TUTTI i run.
 */
import { tenantService, TenantNotActiveError, TenantNotFoundError } from './tenant.service.js';
import { recordFailOpen } from '@/lib/fail-open-metrics.js';

export function assertTenantCanExecute(tenantId: string): void {
  try {
    tenantService.assertActive(tenantId);
  } catch (e) {
    // SOLO un tenant accertato non-attivo blocca il run (fail-closed mirato).
    if (e instanceof TenantNotActiveError) throw e;
    // NotFound è un fail-open BENIGNO e atteso (tenant non ancora in tabella,
    // dev, container core): non lo strumentiamo per non generare rumore.
    if (e instanceof TenantNotFoundError) return;
    // Tutto il resto (DB error / imprevisti) è un fail-open ANOMALO: il gate
    // billing è degradato → un tenant sospeso potrebbe eseguire. Alertabile.
    recordFailOpen('execution_gate', e, { tenantId });
  }
}
