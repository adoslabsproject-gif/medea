/**
 * Regole sui valori inventati.
 *
 * Un modello che non conosce il tuo dominio, il tuo bucket o l'id del tuo
 * database non lascia il campo vuoto: ci mette qualcosa di plausibile. È il
 * motivo per cui questi controlli esistono — un `example.com` supera ogni
 * validazione di forma e fallisce sempre al primo giro.
 */

import { PICKER_PLACEHOLDER } from '../constants';

import { asSearchable } from './graph';
import { CRITICAL_FIELD_RE, CRITICAL_VALUE_RE, MOCK_PATTERNS } from './mock-patterns';
import type { QualityGateInput, QualityIssue } from './types';

/** Valori riconoscibilmente segnaposto in qualunque campo. */
export function checkMockPlaceholders(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    for (const [field, val] of Object.entries(node.config)) {
      const text = asSearchable(val);
      for (const { regex, reason, suggest } of MOCK_PATTERNS) {
        if (!regex.test(text)) continue;
        // Su host, URL, bucket e credenziali il workflow si rompe subito; su
        // un destinatario email l'utente se ne accorge e corregge.
        const critical = CRITICAL_FIELD_RE.test(field) || CRITICAL_VALUE_RE.test(text);
        const suggestion = suggest ? ` → usa ${suggest}` : '';
        issues.push({
          severity: critical ? 'critical' : 'medium',
          code: 'MOCK_PLACEHOLDER',
          nodeId: node.id,
          field,
          message: `Il campo "${field}" contiene ${reason}${suggestion}`,
        });
        break; // un segnalibro per campo basta
      }
    }
  }
  return issues;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** nanoid 21, ULID 26, ObjectId 24: tutti sopra i 16 caratteri. */
const HASH_ID_RE = /^[A-Za-z0-9_-]{16,}$/;

const ID_FIELD_RE =
  /^(databaseId|tableId|workspaceId|projectId|accountId|userId|tenantId|systemAccountId|botId|channelId|spaceId|orgId)$/i;
const ID_FIELD_SNAKE_RE =
  /^(database|table|workspace|project|account|tenant|email_account|system_account)_?(id|name|key)$/i;

/** Parole sospette anche dentro snake_case o kebab-case. */
const SUSPECT_WORD_RE =
  /(?:^|[_\-\s])(name|placeholder|example|sample|here|todo|fixme|test|demo|fake|mock|your|my|company|new|generic|opportunities|customers|orders|invoices|leads|account|database|table)(?:[_\-\s]|$)/i;

/** Il pattern pigro «tipo_parola» senza nessuna parte casuale. */
const LAZY_ID_RE =
  /^(db|acc|tenant|workspace|project|user|email|smtp|imap|system|sys|table|tbl|col|field|node|wf|workflow)[_-][a-z]+(?:[_-][a-z]+)?$/i;

/**
 * Identificativi di risorse che non sembrano veri. Diverso dal controllo
 * sopra: qui si guardano SOLO i campi che devono contenere un id, e si
 * pretende che assomiglino a un id — un UUID o una stringa hash.
 */
export function checkSuspiciousResourceIds(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const node of input.nodes) {
    for (const [field, val] of Object.entries(node.config)) {
      if (typeof val !== 'string' || val.length === 0) continue;
      // Le espressioni si risolvono a runtime: non sono valori inventati.
      if (val.includes('{{') || val.includes('$node.') || val.includes('secrets.')) continue;
      // Il segnaposto del menu è un impegno esplicito a chiedere all'utente.
      if (val === PICKER_PLACEHOLDER) continue;
      if (!ID_FIELD_RE.test(field) && !ID_FIELD_SNAKE_RE.test(field)) continue;

      const looksLikeRealId = UUID_RE.test(val) || HASH_ID_RE.test(val);
      if (looksLikeRealId && !SUSPECT_WORD_RE.test(val) && !LAZY_ID_RE.test(val)) continue;

      issues.push({
        severity: 'critical',
        code: 'SUSPICIOUS_RESOURCE_ID',
        nodeId: node.id,
        field,
        message: `Il campo "${field}" vale "${val}", che non sembra un identificativo reale (ci si aspetta un UUID o una stringa lunga). È probabilmente un valore inventato: sceglilo dal menu a tendina prima di importare.`,
      });
    }
  }
  return issues;
}
