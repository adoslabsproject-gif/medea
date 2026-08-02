/**
 * semantic-rules — regole di qualità SEMANTICHE di FLUSSO per i workflow generati.
 *
 * Il quality-gate "classico" vede la STRUTTURA (URL/required/grafo/cicli/shape).
 * Questi controlli vedono la LOGICA, cioè gli errori che un senior coglie
 * rileggendo il flusso:
 *   • ERROR_BRANCH_INVERTED — il ramo di SUCCESSO di un handler d'errore finisce
 *     in una dead-letter/error-sink (es. fattura RIUSCITA → DLQ). Bug reale.
 *   • ERROR_HANDLER_NO_SINK — un handler d'errore le cui diramazioni non
 *     raggiungono MAI un sink che registra/instrada il fallimento (DLQ/alert/log).
 *   • LOOKUP_WITHOUT_BRANCH — un "lookup" che alimenta DIRETTAMENTE un "create"
 *     senza logic_if sull'esito (manca l'upsert "se esiste aggiorna, altrimenti crea").
 *
 * Le regole su STRUTTURA/CONFIG (trigger-no-op, audit non terminale, secret
 * hard-coded) vivono in semantic-rules-config.ts; gli helper di grafo in
 * semantic-rules-shared.ts (no-monoliti). `runSemanticRules` le aggrega tutte.
 *
 * Euristiche conservative (critical solo per l'inversione palese) → alimentano il
 * loop di repair, senza bocciare flussi legittimi. Puro: niente I/O.
 *
 * @module services/ai-scaffold/semantic-rules
 */
import type { QualityGateInput, QualityIssue } from '@/services/ai-scaffold/quality-gate.js';
import {
  asStr,
  buildGraph,
  reachesForward,
  type SemNode,
} from '@/services/ai-scaffold/semantic-rules-shared.js';
import {
  checkTriggerWithoutAction,
  checkAuditNotTerminal,
  checkSensitiveHardcoded,
} from '@/services/ai-scaffold/semantic-rules-config.js';

/** Condizione che TESTA un errore/fallimento (true ⇒ ERRORE). */
const ERROR_CONDITION_RE =
  /(>=\s*[45]\d\d)|status\s*[<>=!]=?\s*[45]\d\d|[!=]==?\s*['"]?error['"]?|!==?\s*['"]?(200|ok|success|done)['"]?|\.error\b|\.failed\b|\bisError\b|\bhasError\b|\bfailure\b/i;

/** Un nodo che REGISTRA/INSTRADA un fallimento (dead-letter, alert, error-log). */
function isErrorSink(node: SemNode): boolean {
  const hay = [node.id, node.defId, asStr(node.config.table), asStr(node.config.channel)]
    .join(' ')
    .toLowerCase();
  return /\bdlq\b|dead.?letter|fallit|errori?\b|error|fail/.test(hay);
}

/** GET che "cerca" un'entità esistente (lookup). Solo nodi HTTP/community. */
function isEntityLookup(node: SemNode): boolean {
  if (!/^(action_http|community_)/.test(node.defId)) return false;
  const method = asStr(node.config.method).toUpperCase();
  if (method && method !== 'GET') return false;
  const hay = [node.id, asStr(node.config.url), asStr(node.config.path)].join(' ').toLowerCase();
  return /lookup|\bfind\b|search|\/profile|exists|get.?by|\/contact|\/customer|\/cliente|crm/.test(
    hay,
  );
}

/** POST/insert che CREA una nuova entità. */
function isEntityCreate(node: SemNode): boolean {
  const method = asStr(node.config.method).toUpperCase();
  const hay = [node.id, node.defId, asStr(node.config.url), asStr(node.config.path)]
    .join(' ')
    .toLowerCase();
  const looksCreate = /\bcre[a|ate]|\bnew\b|insert|\/contact|\/customer|register/.test(hay);
  if (node.defId === 'db_insert')
    return looksCreate || /crea|create|new/.test(node.id.toLowerCase());
  return method === 'POST' && looksCreate;
}

// ── Rule A: ramo d'errore invertito (success → dead-letter) ──────────────────
export function checkErrorBranchInverted(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const g = buildGraph(input);
  for (const node of input.nodes) {
    if (node.defId !== 'logic_if') continue;
    const cond = asStr(node.config.condition);
    if (!ERROR_CONDITION_RE.test(cond)) continue;
    const outs = g.outByPort.get(node.id) ?? [];
    const successPort = outs.find((e) => e.fromPort === 'false');
    if (!successPort) continue;
    const sink = reachesForward(g, successPort.to, isErrorSink);
    const errorPort = outs.find((e) => e.fromPort === 'true');
    const errorGoesToSink = errorPort ? reachesForward(g, errorPort.to, isErrorSink) : false;
    // Segnala SOLO se il successo va in un sink E l'errore NON va in un sink
    // (rami scambiati, non un caso in cui entrambi loggano).
    if (sink && !errorGoesToSink) {
      issues.push({
        severity: 'critical',
        code: 'ERROR_BRANCH_INVERTED',
        nodeId: node.id,
        message:
          `Il nodo "${node.id}" (logic_if) testa un ERRORE (condizione "${cond.slice(0, 80)}") ma il ramo di ` +
          `SUCCESSO (false) finisce in una dead-letter/error-sink. I rami sono invertiti: il successo non deve ` +
          `andare in DLQ. Inverti i rami (errore→DLQ/retry, successo→prosegui) o correggi la condizione.`,
      });
    }
  }
  return issues;
}

// ── Rule B: handler d'errore senza sink (errore che evapora) ─────────────────
export function checkErrorHandlerNoSink(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const g = buildGraph(input);
  for (const node of input.nodes) {
    if (node.defId !== 'logic_if' && node.defId !== 'logic_switch') continue;
    const cond = asStr(node.config.condition) || asStr(node.config.expression);
    if (!ERROR_CONDITION_RE.test(cond)) continue;
    const outs = g.outByPort.get(node.id) ?? [];
    if (outs.length === 0) continue;
    const anySink = outs.some((e) => reachesForward(g, e.to, isErrorSink));
    if (!anySink) {
      issues.push({
        severity: 'medium',
        code: 'ERROR_HANDLER_NO_SINK',
        nodeId: node.id,
        message:
          `Il nodo "${node.id}" gestisce un errore (condizione "${cond.slice(0, 80)}") ma nessuna diramazione ` +
          `raggiunge un sink che lo registri/instradi (DLQ, alert Slack/Telegram, log audit). ` +
          `Aggiungi una destinazione per il fallimento, altrimenti l'errore evapora (es. retry senza ricontrollo→DLQ).`,
      });
    }
  }
  return issues;
}

// ── Rule C: lookup → create senza IF (upsert mancante) ───────────────────────
export function checkLookupWithoutBranch(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const g = buildGraph(input);
  for (const e of input.edges) {
    const from = g.byId.get(e.from);
    const to = g.byId.get(e.to);
    if (!from || !to) continue;
    if (!isEntityLookup(from) || !isEntityCreate(to)) continue;
    issues.push({
      severity: 'medium',
      code: 'LOOKUP_WITHOUT_BRANCH',
      nodeId: to.id,
      message:
        `"${from.id}" cerca un'entità e alimenta DIRETTAMENTE "${to.id}" che la CREA, senza un logic_if ` +
        `sull'esito del lookup: il nodo creerà sempre, anche se l'entità esiste già. Inserisci un logic_if ` +
        `("se esiste → aggiorna, altrimenti → crea") tra il lookup e il create.`,
    });
  }
  return issues;
}

/** Tutte le regole semantiche in un colpo (flusso + struttura/config). Ordine stabile. */
export function runSemanticRules(input: QualityGateInput): QualityIssue[] {
  return [
    ...checkErrorBranchInverted(input),
    ...checkErrorHandlerNoSink(input),
    ...checkLookupWithoutBranch(input),
    ...checkTriggerWithoutAction(input),
    ...checkAuditNotTerminal(input),
    ...checkSensitiveHardcoded(input),
  ];
}
