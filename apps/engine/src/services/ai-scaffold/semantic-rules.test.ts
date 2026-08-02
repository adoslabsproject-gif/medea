/**
 * Test semantic-rules — la LOGICA del workflow, non la struttura. Bug-bounty sui
 * pattern reali (incl. il bug DLQ-su-successo del workflow e-commerce 2026-06-17)
 * + i NON-falsi-positivi (flussi corretti NON devono essere segnalati).
 */
import { describe, it, expect } from 'vitest';
import {
  checkErrorBranchInverted,
  checkErrorHandlerNoSink,
  checkLookupWithoutBranch,
  runSemanticRules,
} from './semantic-rules.js';
import type { QualityGateInput } from './quality-gate.js';

type N = QualityGateInput['nodes'][number];
const node = (id: string, defId: string, config: Record<string, unknown> = {}): N => ({
  id,
  defId,
  config,
});
const edge = (from: string, to: string, fromPort?: string): QualityGateInput['edges'][number] =>
  ({ from, to, ...(fromPort ? { fromPort } : {}) }) as QualityGateInput['edges'][number];
const wf = (nodes: N[], edges: QualityGateInput['edges']): QualityGateInput => ({ nodes, edges });

describe('checkErrorBranchInverted — DLQ-su-successo (bug reale)', () => {
  it('🚨 if(status==="error") true→retry, false(successo)→dlq → INVERTITO (critical)', () => {
    const input = wf(
      [
        node('fattura', 'action_http', { method: 'POST', url: 'https://x/invoices' }),
        node('gestione_errore', 'logic_if', { condition: "$node.fattura.json.status === 'error'" }),
        node('retry_fattura', 'action_http', { method: 'POST', url: 'https://x/retry' }),
        node('dlq', 'db_insert', { table: 'fatturazione_dlq' }),
      ],
      [
        edge('fattura', 'gestione_errore'),
        edge('gestione_errore', 'retry_fattura', 'true'),
        edge('gestione_errore', 'dlq', 'false'),
      ],
    );
    const issues = checkErrorBranchInverted(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('ERROR_BRANCH_INVERTED');
    expect(issues[0]!.severity).toBe('critical');
    expect(issues[0]!.nodeId).toBe('gestione_errore');
  });

  it('🚨 CORRETTO: error(true)→dlq, success(false)→prosegui → NESSUNA segnalazione', () => {
    const input = wf(
      [
        node('fattura', 'action_http', { method: 'POST', url: 'https://x/invoices' }),
        node('gestione_errore', 'logic_if', { condition: '$node.fattura.json.status >= 400' }),
        node('dlq', 'db_insert', { table: 'fatturazione_dlq' }),
        node('prosegui', 'action_send_email', { to: 'a@b.it' }),
      ],
      [edge('gestione_errore', 'dlq', 'true'), edge('gestione_errore', 'prosegui', 'false')],
    );
    expect(checkErrorBranchInverted(input)).toEqual([]); // mut: rami giusti → nessun flag
  });

  it('entrambi i rami loggano (error→dlq, success→audit_error) → non flaggato come invertito', () => {
    const input = wf(
      [
        node('h', 'logic_if', { condition: "status === 'error'" }),
        node('dlq', 'db_insert', { table: 'dlq' }),
        node('audit_error', 'db_insert', { table: 'error_log' }),
      ],
      [edge('h', 'dlq', 'true'), edge('h', 'audit_error', 'false')],
    );
    // errorGoesToSink=true → non è un'inversione (non spacciamo doppio-log per bug)
    expect(checkErrorBranchInverted(input)).toEqual([]);
  });

  it("logic_if NON d'errore (branch normale) → ignorato", () => {
    const input = wf(
      [
        node('h', 'logic_if', { condition: "$node.x.json.priority === 'alta'" }),
        node('dlq', 'db_insert', { table: 'dlq' }),
      ],
      [edge('h', 'dlq', 'false')],
    );
    expect(checkErrorBranchInverted(input)).toEqual([]); // mut: condizione non-errore → skip
  });
});

describe('checkErrorHandlerNoSink — errore che evapora', () => {
  it('🚨 handler errore, nessun ramo raggiunge un sink → medium', () => {
    const input = wf(
      [
        node('h', 'logic_if', { condition: 'status >= 500' }),
        node('retry', 'action_http', { method: 'POST', url: 'https://x/retry' }), // no sink, no uscita
        node('cont', 'action_send_email', { to: 'a@b' }),
      ],
      [edge('h', 'retry', 'true'), edge('h', 'cont', 'false')],
    );
    const issues = checkErrorHandlerNoSink(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('ERROR_HANDLER_NO_SINK');
  });

  it('handler errore con DLQ raggiungibile → nessun flag', () => {
    const input = wf(
      [
        node('h', 'logic_if', { condition: 'status >= 500' }),
        node('dlq', 'db_insert', { table: 'dlq' }),
        node('c', 'action_send_email', {}),
      ],
      [edge('h', 'dlq', 'true'), edge('h', 'c', 'false')],
    );
    expect(checkErrorHandlerNoSink(input)).toEqual([]);
  });

  it('🚨 retry che POI raggiunge la DLQ a valle → nessun flag (sink reachable forward)', () => {
    const input = wf(
      [
        node('h', 'logic_if', { condition: "result === 'error'" }),
        node('retry', 'action_http', { method: 'POST', url: 'u' }),
        node('dlq', 'db_insert', { table: 'dlq' }),
      ],
      [edge('h', 'retry', 'true'), edge('retry', 'dlq')],
    );
    expect(checkErrorHandlerNoSink(input)).toEqual([]); // reachesForward attraversa retry→dlq
  });
});

describe('checkLookupWithoutBranch — upsert mancante', () => {
  it('🚨 lookup GET /contact → create POST /contact diretto → medium', () => {
    const input = wf(
      [
        node('lookup_crm', 'action_http', {
          method: 'GET',
          url: '{{secrets.HUBSPOT_API_URL}}/contacts/{{x}}',
        }),
        node('crea_contatto', 'action_http', {
          method: 'POST',
          url: '{{secrets.HUBSPOT_API_URL}}/contacts',
        }),
      ],
      [edge('lookup_crm', 'crea_contatto')],
    );
    const issues = checkLookupWithoutBranch(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('LOOKUP_WITHOUT_BRANCH');
    expect(issues[0]!.nodeId).toBe('crea_contatto');
  });

  it('lookup → logic_if → create (IF presente) → NESSUN flag', () => {
    const input = wf(
      [
        node('lookup_crm', 'action_http', { method: 'GET', url: 'https://x/contacts/find' }),
        node('exists', 'logic_if', { condition: '$node.lookup_crm.json.found === true' }),
        node('crea', 'action_http', { method: 'POST', url: 'https://x/contacts' }),
      ],
      [edge('lookup_crm', 'exists'), edge('exists', 'crea', 'false')],
    );
    expect(checkLookupWithoutBranch(input)).toEqual([]); // mut: edge lookup→if, non lookup→create
  });

  it('GET generico (non lookup-entità) → create → non flaggato', () => {
    const input = wf(
      [
        node('fetch_meteo', 'action_http', { method: 'GET', url: 'https://api.meteo/today' }),
        node('crea', 'db_insert', { table: 'log' }),
      ],
      [edge('fetch_meteo', 'crea')],
    );
    expect(checkLookupWithoutBranch(input)).toEqual([]);
  });
});

describe('runSemanticRules — aggregato deterministico', () => {
  it('workflow pulito → nessuna issue semantica', () => {
    const input = wf(
      [node('w', 'trigger_webhook', {}), node('e', 'action_send_email', { to: 'a@b' })],
      [edge('w', 'e')],
    );
    expect(runSemanticRules(input)).toEqual([]);
  });
});
