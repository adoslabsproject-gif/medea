/**
 * Negative-example capture — registra in ai_interactions i workflow generati
 * dall'AI scaffold ma RIFIUTATI dal quality-gate al tentativo FINALE (gap #10
 * masterplan: chiude il TODO in singleshot.service.ts).
 *
 * Valore: dataset di esempi "prompt → workflow cattivo → perché è stato
 * rifiutato" per il training LoRA futuro (NHA-v2). Solo i reject FINALI
 * (retry esauriti) sono negative genuini — quelli intermedi vengono
 * auto-corretti e non rappresentano un fallimento del modello.
 *
 * Fail-soft TOTALE: la cattura è best-effort. La richiesta dell'utente è già
 * un errore 502 (workflow rifiutato) — un problema nel logging NON deve
 * cambiare quella risposta né lanciare. `insert()` ritorna null se il tenant
 * ha il training capture disabilitato (opt-out) → no-op silenzioso.
 *
 * PII: AIInteractionsService redige prompt e patch PRIMA dell'insert.
 */
import { AIInteractionsService } from '@/services/ai-interactions.service.js';
import { logger } from '@/lib/logger.js';

const log = logger.child({ mod: 'ai-scaffold-negative' });

export interface RejectedScaffoldArgs {
  tenantId: string;
  goal: string;
  /** Il workflow GENERATO ma rifiutato (nodi+edge) — è il "negative". */
  rejectedWorkflow: { nodes: unknown[]; edges: unknown[] };
  /** Issue critici del quality-gate = il MOTIVO del rifiuto. */
  criticalIssues: { code: string; message: string }[];
  model: string;
  latencyMs: number;
}

/**
 * Inserisce l'interazione (outcome=pending) e la marca subito 'rejected'.
 * Sincrono-ish ma incapsulato: il chiamante fa `void` (fire-and-forget) o
 * await dentro un try/catch — qui non lanciamo MAI.
 */
/**
 * RIUSO dei negative examples (la metà mancante del gap #10): i reject
 * FINALI registrati diventano un blocco "errori frequenti da evitare" nel
 * prompt singleshot. Pre-fix erano SOLO scritti (dataset LoRA futuro), mai
 * riletti: il modello ripeteva gli stessi errori di ieri.
 *
 * Aggregazione: ultimi `limit` reject del tenant → frequenza per codice
 * quality-gate → top-N codici col messaggio più RECENTE come esempio
 * concreto. Vuoto se il tenant non ha storia (cold start pulito). Fail-soft:
 * un errore qui non deve mai bloccare lo scaffold.
 */
export function buildNegativeFeedbackBlock(
  tenantId: string,
  opts: { limit?: number; topCodes?: number } = {},
): string {
  try {
    const service = new AIInteractionsService();
    const { rows } = service.list({
      tenantId,
      interactionType: 'workflow_from_text',
      outcome: 'rejected',
      limit: opts.limit ?? 20,
    });
    if (rows.length === 0) return '';
    // responseMessage formato (vedi captureRejectedScaffold):
    //   "QUALITY-GATE REJECT (final):\n[CODE] messaggio\n[CODE2] …"
    const byCode = new Map<string, { count: number; example: string }>();
    for (const row of rows) {
      for (const line of row.responseMessage.split('\n')) {
        const m = /^\[([A-Z0-9_]+)\]\s*(.+)$/u.exec(line.trim());
        if (!m?.[1] || !m[2]) continue;
        const code = m[1];
        const cur = byCode.get(code);
        // rows è ORDER BY created_at DESC → il primo esempio visto è il più recente.
        if (cur) cur.count += 1;
        else byCode.set(code, { count: 1, example: m[2].slice(0, 160) });
      }
    }
    if (byCode.size === 0) return '';
    const top = Array.from(byCode.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, opts.topCodes ?? 5);
    const lines = top.map(([code, v]) => `• [${code}] ×${String(v.count)} — es. "${v.example}"`);
    return [
      '### ⚠️ ERRORI FREQUENTI nei TUOI workflow passati per QUESTO tenant (rifiutati dal quality gate) — NON ripeterli:',
      ...lines,
    ].join('\n');
  } catch (err) {
    log.debug({ tenantId, err: String(err) }, 'negative feedback block failed (fail-soft)');
    return '';
  }
}

export function captureRejectedScaffold(args: RejectedScaffoldArgs): void {
  try {
    const service = new AIInteractionsService();
    const reasons = args.criticalIssues
      .slice(0, 10)
      .map((i) => `[${i.code}] ${i.message}`)
      .join('\n');
    const id = service.insert({
      context: { tenantId: args.tenantId },
      interactionType: 'workflow_from_text',
      request: { prompt: args.goal },
      response: {
        message: `QUALITY-GATE REJECT (final):\n${reasons}`,
        patch: args.rejectedWorkflow,
        model: args.model || 'unknown',
        latencyMs: args.latencyMs,
      },
    });
    // id === null → capture disabilitato per il tenant (opt-out). Niente da fare.
    if (id === null) return;
    service.updateOutcome({ interactionId: id, tenantId: args.tenantId, outcome: 'rejected' });
    log.info(
      { tenantId: args.tenantId, id, criticalCount: args.criticalIssues.length },
      'negative example registrato',
    );
  } catch (err) {
    // Fail-soft assoluto: mai propagare.
    log.warn(
      { tenantId: args.tenantId, err: String(err) },
      'negative example capture failed (non-fatal)',
    );
  }
}
