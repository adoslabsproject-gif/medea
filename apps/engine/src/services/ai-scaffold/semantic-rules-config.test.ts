/**
 * Test semantic-rules-config — TRIGGER_WITHOUT_ACTION / AUDIT_NOT_TERMINAL /
 * SENSITIVE_HARDCODED. Bug-bounty + NON-falsi-positivi (incl. apiKeyHeaderName,
 * che è un NOME header e NON un segreto).
 */
import { describe, it, expect } from 'vitest';
import {
  checkTriggerWithoutAction,
  checkAuditNotTerminal,
  checkSensitiveHardcoded,
} from './semantic-rules-config.js';
import type { QualityGateInput } from './quality-gate.js';

type N = QualityGateInput['nodes'][number];
const node = (id: string, defId: string, config: Record<string, unknown> = {}): N => ({
  id,
  defId,
  config,
});
const edge = (from: string, to: string): QualityGateInput['edges'][number] => ({ from, to });
const wf = (nodes: N[], edges: QualityGateInput['edges'] = []): QualityGateInput => ({
  nodes,
  edges,
});

describe('checkTriggerWithoutAction', () => {
  it('🚨 solo trigger + logic, nessuna azione → medium', () => {
    const r = checkTriggerWithoutAction(
      wf([node('w', 'trigger_webhook'), node('if', 'logic_if', { condition: 'x' })]),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.code).toBe('TRIGGER_WITHOUT_ACTION');
  });
  it('trigger + action → nessun flag', () => {
    expect(
      checkTriggerWithoutAction(wf([node('w', 'trigger_webhook'), node('e', 'action_send_email')])),
    ).toEqual([]);
  });
  it('trigger + db_insert → nessun flag', () => {
    expect(
      checkTriggerWithoutAction(
        wf([node('w', 'trigger_cron'), node('d', 'db_insert', { table: 't' })]),
      ),
    ).toEqual([]);
  });
  it('🚨 senza trigger → non è competenza di questa rule (orphan altrove)', () => {
    expect(checkTriggerWithoutAction(wf([node('if', 'logic_if', {})]))).toEqual([]);
  });
});

describe('checkAuditNotTerminal', () => {
  it('🚨 audit con azione esterna a valle → info (non cattura stato finale)', () => {
    const input = wf(
      [
        node('audit', 'db_insert', { table: 'order_audit' }),
        node('email', 'action_send_email', { to: 'a@b' }),
      ],
      [edge('audit', 'email')],
    );
    const r = checkAuditNotTerminal(input);
    expect(r).toHaveLength(1);
    expect(r[0]!.code).toBe('AUDIT_NOT_TERMINAL');
    expect(r[0]!.severity).toBe('info');
  });
  it('audit TERMINALE (a fine flusso) → nessun flag', () => {
    const input = wf(
      [
        node('email', 'action_send_email', { to: 'a@b' }),
        node('audit', 'db_insert', { table: 'order_audit' }),
      ],
      [edge('email', 'audit')],
    );
    expect(checkAuditNotTerminal(input)).toEqual([]);
  });
  it('db_insert NON-audit con azione a valle → ignorato (solo audit/log)', () => {
    const input = wf(
      [node('save', 'db_insert', { table: 'orders' }), node('email', 'action_send_email', {})],
      [edge('save', 'email')],
    );
    expect(checkAuditNotTerminal(input)).toEqual([]);
  });
});

describe('checkSensitiveHardcoded', () => {
  it('🚨 apiKey hard-coded → medium', () => {
    const r = checkSensitiveHardcoded(
      wf([node('h', 'action_http', { apiKey: 'sk-live-abcdef123456' })]),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.code).toBe('SENSITIVE_HARDCODED');
    expect(r[0]!.field).toBe('apiKey');
  });
  it('apiKey come {{secrets.X}} → nessun flag', () => {
    expect(
      checkSensitiveHardcoded(
        wf([node('h', 'action_http', { apiKey: '{{secrets.OPENAI_API_KEY}}' })]),
      ),
    ).toEqual([]);
  });
  it('🚨 NON falso positivo: apiKeyHeaderName è un NOME header, non un segreto', () => {
    const r = checkSensitiveHardcoded(
      wf([
        node('h', 'action_http', {
          apiKeyHeaderName: 'X-Auth-Token',
          apiKeyValue: '{{secrets.K}}',
        }),
      ]),
    );
    expect(r).toEqual([]); // mut: se togliamo il disqualifier, apiKeyHeaderName verrebbe flaggato → FP
  });

  it('🚨 apiKeyValue hard-coded → FLAGGATO (è il vero campo segreto; "value" non disqualifica)', () => {
    const r = checkSensitiveHardcoded(
      wf([
        node('h', 'action_http', {
          apiKeyHeaderName: 'X-Api-Key',
          apiKeyValue: 'sk-real-secret-1234567',
        }),
      ]),
    );
    expect(r.map((i) => i.field)).toEqual(['apiKeyValue']); // apiKeyValue sì, apiKeyHeaderName no
  });
  it('bearerToken hard-coded → medium; authMode enum "bearer" → ignorato', () => {
    const r = checkSensitiveHardcoded(
      wf([node('h', 'action_http', { authMode: 'bearer', bearerToken: 'eyJ-abcdef-123456' })]),
    );
    expect(r.map((i) => i.field)).toEqual(['bearerToken']);
  });
  it('valore breve (<8) → ignorato (probabile enum/flag, non segreto)', () => {
    expect(checkSensitiveHardcoded(wf([node('h', 'action_http', { token: 'abc' })]))).toEqual([]);
  });
  it('__pending__ / __USE_PICKER__ → ignorati', () => {
    expect(
      checkSensitiveHardcoded(wf([node('h', 'action_http', { password: '__pending__' })])),
    ).toEqual([]);
  });
});
