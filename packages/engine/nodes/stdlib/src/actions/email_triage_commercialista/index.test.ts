/**
 * Test del nodo `agent_email_triage_commercialista`.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { NodeExecutionContext } from '../../types.js';
import { emailTriageCommercialistaActionNode } from './index.js';
import { ValidationError } from '../../core/node-error.js';

const ctx: NodeExecutionContext = {
  workflowId: 'wf',
  runId: 'r',
  nodeId: 'n',
  tenantId: 't',
  userId: 'u',
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

describe('emailTriageCommercialistaExecutor', () => {
  it('classifies F24 with normal suggested operator', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {},
      {
        subject: 'F24 ravvedimento',
        body: 'codice tributo 1040',
      },
      ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.label).toBe('f24');
    expect(o.suggestedOperator).toBe('pagamenti@studio');
    expect(o.urgencyTier).toBe('high');
  });

  it('honours operatorsJson override per-label', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {
        operatorsJson: '{"f24":"marco@custom.it"}',
      },
      { subject: 'F24', body: '' },
      ctx,
    );
    expect((r.output as Record<string, unknown>).suggestedOperator).toBe('marco@custom.it');
  });

  it('honours replyTemplatesJson override', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {
        replyTemplatesJson: '{"sollecito":"OK ricevuto"}',
      },
      { subject: 'SOLLECITO', body: '' },
      ctx,
    );
    expect((r.output as Record<string, unknown>).suggestedReplyTemplate).toBe('OK ricevuto');
  });

  it('honours urgencyJson override + rejects invalid tier', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {
        urgencyJson: '{"payment":"normal"}',
      },
      { subject: 'Bonifico effettuato', body: '' },
      ctx,
    );
    expect((r.output as Record<string, unknown>).urgencyTier).toBe('normal');

    await expect(
      emailTriageCommercialistaActionNode.executor(
        {
          urgencyJson: '{"payment":"emergency"}',
        },
        { subject: 'X', body: '' },
        ctx,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('pass-through preserves subject/from while adding triage fields', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {},
      {
        subject: 'SOLLECITO pagamento',
        from: 'cliente@x.it',
        body: 'pagamento mancato',
      },
      ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.from).toBe('cliente@x.it');
    expect(o.label).toBe('sollecito');
    expect(o.confidence as number).toBeGreaterThan(0.5);
  });

  it('returns "altro" with low confidence on irrelevant body', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {},
      {
        subject: 'Auguri',
        body: 'Buone vacanze!',
      },
      ctx,
    );
    const o = r.output as Record<string, unknown>;
    expect(o.label).toBe('altro');
    expect(o.confidence as number).toBeLessThan(0.2);
  });

  it('uses custom field names when configured', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {
        subjectField: 'subj',
        bodyField: 'msg',
      },
      { subj: 'F24', msg: 'codice tributo' },
      ctx,
    );
    expect((r.output as Record<string, unknown>).label).toBe('f24');
  });

  it('rejects malformed operatorsJson', async () => {
    await expect(
      emailTriageCommercialistaActionNode.executor(
        {
          operatorsJson: '{not-json}',
        },
        { subject: 'X', body: '' },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('ignores unknown labels in override (defensive)', async () => {
    const r = await emailTriageCommercialistaActionNode.executor(
      {
        operatorsJson: '{"unknown_label":"junk@x"}',
      },
      { subject: 'F24', body: '' },
      ctx,
    );
    // Default mapping kept
    expect((r.output as Record<string, unknown>).suggestedOperator).toBe('pagamenti@studio');
  });
});
