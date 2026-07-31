/**
 * Regole sulla logica del flusso — quelle che un collega esperto coglierebbe
 * rileggendo il disegno.
 *
 * Non c'è niente di malformato in un workflow dove il ramo del SUCCESSO
 * finisce nella coda degli errori: la struttura è perfetta, il grafo è
 * connesso, i campi ci sono tutti. È semplicemente sbagliato, e se ne accorge
 * solo chi legge cosa vuol dire.
 *
 * Le euristiche sono prudenti apposta: segnalano quando il segnale è chiaro,
 * tacciono quando potrebbe esserci una ragione legittima.
 */

import { asStr, buildGraph, reachesForward } from './graph';
import type { QualityGateInput, QualityIssue, QualityNode } from './types';

/** Una condizione che verifica un fallimento (vero significa «è andata male»). */
const ERROR_CONDITION_RE =
  /(>=\s*[45]\d\d)|status\s*[<>=!]=?\s*[45]\d\d|[!=]==?\s*['"]?error['"]?|!==?\s*['"]?(200|ok|success|done)['"]?|\.error\b|\.failed\b|\bisError\b|\bhasError\b|\bfailure\b/i;

/** Un nodo che registra o instrada un fallimento: coda di scarto, avviso, log. */
function isErrorSink(node: QualityNode): boolean {
  const hay = [node.id, node.defId, asStr(node.config.table), asStr(node.config.channel)]
    .join(' ')
    .toLowerCase();
  return /\bdlq\b|dead.?letter|fallit|errori?\b|error|fail/.test(hay);
}

/** Una GET che cerca un'entità già esistente. */
function isEntityLookup(node: QualityNode): boolean {
  if (!/^(action_http|community_)/.test(node.defId)) return false;
  const method = asStr(node.config.method).toUpperCase();
  if (method && method !== 'GET') return false;
  const hay = [node.id, asStr(node.config.url), asStr(node.config.path)].join(' ').toLowerCase();
  return /lookup|\bfind\b|search|\/profile|exists|get.?by|\/contact|\/customer|\/cliente|crm/.test(
    hay,
  );
}

/** Una POST o un inserimento che crea una nuova entità. */
function isEntityCreate(node: QualityNode): boolean {
  const method = asStr(node.config.method).toUpperCase();
  const hay = [node.id, node.defId, asStr(node.config.url), asStr(node.config.path)]
    .join(' ')
    .toLowerCase();
  const looksCreate = /\bcre[a|ate]|\bnew\b|insert|\/contact|\/customer|register/.test(hay);
  if (node.defId === 'db_insert')
    return looksCreate || /crea|create|new/.test(node.id.toLowerCase());
  return method === 'POST' && looksCreate;
}

/** Il ramo del successo che finisce nella coda degli errori: rami scambiati. */
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
    const errorPort = outs.find((e) => e.fromPort === 'true');
    const errorGoesToSink = errorPort ? reachesForward(g, errorPort.to, isErrorSink) : false;

    // Si segnala solo se il successo finisce nella coda errori E l'errore no:
    // se entrambi ci finiscono, è un flusso che logga tutto, non un bug.
    if (reachesForward(g, successPort.to, isErrorSink) && !errorGoesToSink) {
      issues.push({
        severity: 'critical',
        code: 'ERROR_BRANCH_INVERTED',
        nodeId: node.id,
        message: `Il nodo "${node.id}" verifica un errore (condizione "${cond.slice(0, 80)}") ma il ramo del SUCCESSO finisce nella coda degli errori. I due rami sono invertiti: l'errore deve andare in coda, il successo deve proseguire.`,
      });
    }
  }
  return issues;
}

/** Un errore gestito che non arriva da nessuna parte: evapora. */
export function checkErrorHandlerNoSink(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const g = buildGraph(input);
  for (const node of input.nodes) {
    if (node.defId !== 'logic_if' && node.defId !== 'logic_switch') continue;
    const cond = asStr(node.config.condition) || asStr(node.config.expression);
    if (!ERROR_CONDITION_RE.test(cond)) continue;

    const outs = g.outByPort.get(node.id) ?? [];
    if (outs.length === 0) continue;
    if (outs.some((e) => reachesForward(g, e.to, isErrorSink))) continue;

    issues.push({
      severity: 'medium',
      code: 'ERROR_HANDLER_NO_SINK',
      nodeId: node.id,
      message: `Il nodo "${node.id}" gestisce un errore (condizione "${cond.slice(0, 80)}") ma nessun ramo arriva a qualcosa che lo registri o lo segnali (coda di scarto, avviso, log). Così il fallimento sparisce senza lasciare traccia.`,
    });
  }
  return issues;
}

/** Un «cerca» collegato direttamente a un «crea»: creerà sempre, anche quando
 *  l'entità esiste già. */
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
      message: `"${from.id}" cerca un'entità e passa direttamente a "${to.id}" che la crea, senza controllare l'esito: verrà creata anche quando esiste già. Metti in mezzo un "logic_if" (se esiste aggiorna, altrimenti crea).`,
    });
  }
  return issues;
}
