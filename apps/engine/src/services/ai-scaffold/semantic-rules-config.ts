/**
 * semantic-rules-config — regole semantiche su STRUTTURA/CONFIG del workflow
 * (complementari a semantic-rules.ts che copre la logica di flusso error/upsert):
 *   • TRIGGER_WITHOUT_ACTION (medium) — trigger ma nessuna azione utile → no-op.
 *   • AUDIT_NOT_TERMINAL (info) — audit/log con effetti esterni a valle → non
 *     cattura lo stato finale (es. "audit SHA-256 immutabile" messo troppo presto).
 *   • SENSITIVE_HARDCODED (medium) — campo segreto con valore hard-coded → secret.
 *
 * Euristiche conservative (info per l'audit, che è il più soggetto a FP).
 *
 * @module services/ai-scaffold/semantic-rules-config
 */
import type { QualityGateInput, QualityIssue } from '@/services/ai-scaffold/quality-gate.js';
import {
  asStr,
  buildGraph,
  reachesForward,
  type SemNode,
} from '@/services/ai-scaffold/semantic-rules-shared.js';

const SIDE_EFFECT_RE = /^(action_|db_|community_|agent_|flow_)/;

export function checkTriggerWithoutAction(input: QualityGateInput): QualityIssue[] {
  const hasTrigger = input.nodes.some((n) => n.defId.startsWith('trigger_'));
  if (!hasTrigger) return []; // senza trigger è un altro problema (orphan)
  if (input.nodes.some((n) => SIDE_EFFECT_RE.test(n.defId))) return [];
  return [
    {
      severity: 'medium',
      code: 'TRIGGER_WITHOUT_ACTION',
      message:
        'Il workflow ha un trigger ma NESSUNA azione utile (action/db/community/agent): non produce alcun effetto. ' +
        'Aggiungi almeno un nodo che faccia qualcosa (invio, scrittura DB, chiamata HTTP, elaborazione AI).',
    },
  ];
}

function isAuditNode(node: SemNode): boolean {
  const hay = [node.id, asStr(node.config.table)].join(' ').toLowerCase();
  return /\baudit\b|audit_|_audit|\blog\b|activity_log|event_log/.test(hay);
}

export function checkAuditNotTerminal(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const g = buildGraph(input);
  for (const node of input.nodes) {
    if (node.defId !== 'db_insert' || !isAuditNode(node)) continue;
    const downstreamSideEffect = (g.outByPort.get(node.id) ?? []).some((e) =>
      reachesForward(g, e.to, (n) => /^(action_(http|send_email|file)|community_)/.test(n.defId)),
    );
    if (downstreamSideEffect) {
      issues.push({
        severity: 'info',
        code: 'AUDIT_NOT_TERMINAL',
        nodeId: node.id,
        message:
          `Il nodo audit/log "${node.id}" non è terminale: a valle ci sono ancora azioni con effetti esterni. ` +
          `Per un audit "stato finale" (es. SHA-256 immutabile) spostalo a FINE flusso, dopo le azioni.`,
      });
    }
  }
  return issues;
}

/** Chiave che PORTA un valore segreto. Logica CONTAINS + disqualifier (entrambi
 *  load-bearing): `apiKeyValue` è un segreto (contiene "apikey", nessun
 *  disqualifier) ma `apiKeyHeaderName` NO (contiene "header"+"name" → è il NOME
 *  dell'header, non il valore). Il disqualifier evita i falsi positivi sui campi
 *  *Name/*Header/*Mode/*Type/*Url/*Id. */
function isSecretValueKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  if (/(name|header|algo|mode|type|url|id|expiry|expires|ttl|method|scope|label|field)/.test(k))
    return false;
  return /(password|passwd|secret|token|apikey|accesskey|privatekey|clientsecret|bearer|dkim)/.test(
    k,
  );
}

function isExpressionOrSentinel(v: string): boolean {
  return v.trim() === '' || /\{\{.*\}\}/.test(v) || v === '__pending__' || v === '__USE_PICKER__';
}

export function checkSensitiveHardcoded(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    for (const [key, raw] of Object.entries(node.config)) {
      if (
        typeof raw !== 'string' ||
        !isSecretValueKey(key) ||
        isExpressionOrSentinel(raw) ||
        raw.length < 8
      )
        continue;
      issues.push({
        severity: 'medium',
        code: 'SENSITIVE_HARDCODED',
        nodeId: node.id,
        field: key,
        message:
          `Il campo sensibile "${key}" di "${node.id}" ha un valore HARD-CODED. ` +
          `Usa \`{{secrets.NOME}}\` — i segreti non vanno scritti nel workflow (l'utente li configura a parte).`,
      });
    }
  }
  return issues;
}
