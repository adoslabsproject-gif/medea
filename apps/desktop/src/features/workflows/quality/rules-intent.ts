/**
 * Regole sull'intenzione complessiva del workflow.
 *
 * Le altre regole guardano un nodo o un collegamento; queste guardano il
 * workflow nel suo insieme e chiedono: serve a qualcosa? l'audit è nel punto
 * giusto? ci sono segreti scritti in chiaro dove chiunque li legge?
 */

import { PENDING_SECRET, PICKER_PLACEHOLDER } from '../constants';

import { asStr, buildGraph, reachesForward } from './graph';
import type { QualityGateInput, QualityIssue, QualityNode } from './types';

const SIDE_EFFECT_RE = /^(action_|db_|community_|agent_|flow_)/;

/** Un trigger e nient'altro: il workflow parte e non fa niente. */
export function checkTriggerWithoutAction(input: QualityGateInput): QualityIssue[] {
  const hasTrigger = input.nodes.some((n) => n.defId.startsWith('trigger_'));
  // Senza trigger il problema è un altro, e lo segnala un'altra regola.
  if (!hasTrigger) return [];
  if (input.nodes.some((n) => SIDE_EFFECT_RE.test(n.defId))) return [];
  return [
    {
      severity: 'medium',
      code: 'TRIGGER_WITHOUT_ACTION',
      message:
        'Il workflow ha un trigger ma nessuna azione: parte e non produce alcun effetto. Aggiungi almeno un nodo che faccia qualcosa (un invio, una scrittura, una chiamata, un’elaborazione).',
    },
  ];
}

function isAuditNode(node: QualityNode): boolean {
  const hay = [node.id, asStr(node.config.table)].join(' ').toLowerCase();
  return /\baudit\b|audit_|_audit|\blog\b|activity_log|event_log/.test(hay);
}

/** Un audit messo troppo presto non registra lo stato finale. */
export function checkAuditNotTerminal(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const g = buildGraph(input);
  for (const node of input.nodes) {
    if (node.defId !== 'db_insert' || !isAuditNode(node)) continue;
    const hasLaterEffects = (g.outByPort.get(node.id) ?? []).some((e) =>
      reachesForward(g, e.to, (n) => /^(action_(http|send_email|file)|community_)/.test(n.defId)),
    );
    if (!hasLaterEffects) continue;
    issues.push({
      severity: 'info',
      code: 'AUDIT_NOT_TERMINAL',
      nodeId: node.id,
      message: `Il nodo di registrazione "${node.id}" non è l'ultimo: dopo di lui ci sono ancora azioni con effetti esterni, quindi non fotografa lo stato finale. Se serve un audit definitivo, spostalo in fondo.`,
    });
  }
  return issues;
}

/**
 * Il nome del campo dice se contiene un segreto. La logica è doppia apposta:
 * `apiKeyValue` è un segreto, `apiKeyHeaderName` no — è il nome dell'header,
 * non il suo valore. Senza la seconda condizione ogni campo `*Name` verrebbe
 * segnalato per sbaglio.
 */
function isSecretValueKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  if (/(name|header|algo|mode|type|url|id|expiry|expires|ttl|method|scope|label|field)/.test(k)) {
    return false;
  }
  return /(password|passwd|secret|token|apikey|accesskey|privatekey|clientsecret|bearer|dkim)/.test(
    k,
  );
}

function isExpressionOrSentinel(v: string): boolean {
  return (
    v.trim() === '' || /\{\{.*\}\}/.test(v) || v === PENDING_SECRET || v === PICKER_PLACEHOLDER
  );
}

/** Un segreto scritto direttamente nel workflow. Finirebbe nel file
 *  esportato, nei backup e in chiunque lo riceva. */
export function checkSensitiveHardcoded(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    for (const [key, raw] of Object.entries(node.config)) {
      if (typeof raw !== 'string') continue;
      if (!isSecretValueKey(key) || isExpressionOrSentinel(raw) || raw.length < 8) continue;
      issues.push({
        severity: 'medium',
        code: 'SENSITIVE_HARDCODED',
        nodeId: node.id,
        field: key,
        message: `Il campo riservato "${key}" di "${node.id}" contiene un valore scritto in chiaro. Usa {{secrets.NOME}}: i segreti non vanno dentro il workflow, li configura l'utente a parte.`,
      });
    }
  }
  return issues;
}
