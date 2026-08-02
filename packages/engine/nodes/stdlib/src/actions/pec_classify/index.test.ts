/**
 * `action_pec_classify` — executor tests.
 *
 * Coverage:
 *   • branch routing: each of the 4 PecMessageType → corresponding branch
 *   • output shape (type, branch, receiptCategory, refMessageId, ...)
 *   • input shape coercion: input.headers vs input.output.headers vs custom path
 *   • input guards: missing headers throw ValidationError
 *   • includeHeadersInOutput filter (only X-* preserved)
 *   • pipelineSteps emission
 */

import { describe, it, expect } from 'vitest';
import { pecClassifyExecutor } from './executor.js';
import { pecClassifyNodeDef } from './definition.js';
import { ValidationError } from '../../core/node-error.js';

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };

describe('pecClassifyExecutor — branch routing', () => {
  it('routes a normal message to "received_message"', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Trasporto': 'posta-certificata', Subject: 'normale' } },
      ctx,
    );
    expect(out.branch).toBe('received_message');
    expect((out.output as Record<string, unknown>).type).toBe('pec_received_message');
  });

  it('routes accettazione to "acceptance_receipt"', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Ricevuta': 'accettazione', 'X-Riferimento-Message-ID': '<x>' } },
      ctx,
    );
    expect(out.branch).toBe('acceptance_receipt');
    expect((out.output as Record<string, unknown>).refMessageId).toBe('<x>');
  });

  it('routes avvenuta-consegna to "delivery_receipt"', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Ricevuta': 'avvenuta-consegna' } },
      ctx,
    );
    expect(out.branch).toBe('delivery_receipt');
  });

  it('routes errore-consegna to "rejection"', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Ricevuta': 'errore-consegna' } },
      ctx,
    );
    expect(out.branch).toBe('rejection');
  });

  it('routes rilevazione-virus to "rejection"', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Ricevuta': 'rilevazione-virus' } },
      ctx,
    );
    expect(out.branch).toBe('rejection');
  });
});

describe('pecClassifyExecutor — input path resolution', () => {
  it('resolves a custom dotted headersPath', async () => {
    const out = await pecClassifyExecutor(
      { headersPath: 'mail.headers' },
      { mail: { headers: { 'X-Ricevuta': 'accettazione' } } },
      ctx,
    );
    expect(out.branch).toBe('acceptance_receipt');
  });

  it('resolves output.headers shape (run-row wrap)', async () => {
    const out = await pecClassifyExecutor(
      { headersPath: 'output.headers' },
      { output: { headers: { 'X-Ricevuta': 'avvenuta-consegna' } } },
      ctx,
    );
    expect(out.branch).toBe('delivery_receipt');
  });

  it('throws ValidationError when headers are missing', async () => {
    await expect(pecClassifyExecutor({}, { foo: 'bar' }, ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('throws ValidationError when headers is an array', async () => {
    await expect(pecClassifyExecutor({}, { headers: ['a', 'b'] }, ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('pecClassifyExecutor — output shape', () => {
  it('emits the X-* headers when includeHeadersInOutput=true (and only those)', async () => {
    const out = await pecClassifyExecutor(
      { includeHeadersInOutput: true },
      {
        headers: {
          'X-Ricevuta': 'accettazione',
          'X-Trasporto': 'posta-certificata',
          Subject: 'sensitive', // must NOT leak
          From: 'a@b.it', // must NOT leak
        },
      },
      ctx,
    );
    const headers = (out.output as Record<string, unknown>).headers as Record<string, string>;
    expect(headers['X-Ricevuta']).toBe('accettazione');
    expect(headers['X-Trasporto']).toBe('posta-certificata');
    expect(headers.Subject).toBeUndefined();
    expect(headers.From).toBeUndefined();
  });

  it('omits headers when includeHeadersInOutput=false (default)', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Ricevuta': 'avvenuta-consegna', Subject: 's' } },
      ctx,
    );
    expect((out.output as Record<string, unknown>).headers).toBeUndefined();
  });

  it('emits pipelineSteps with classification evidence', async () => {
    const out = await pecClassifyExecutor(
      {},
      { headers: { 'X-Ricevuta': 'errore-consegna', 'X-Riferimento-Message-ID': '<ref>' } },
      ctx,
    );
    const steps = (out.output as Record<string, unknown>).pipelineSteps as Record<
      string,
      unknown
    >[];
    expect(steps[0]?.name).toBe('pec_classify');
    const ev = steps[0]?.evidence as Record<string, unknown>;
    expect(ev.type).toBe('pec_rejection');
    expect(ev.refMessageId).toBe('<ref>');
  });
});

// ════════════════════════════════════════════════════════════════════
// NodeDef contract — branching enabled (bug 2026-06-05 fan-out)
// ════════════════════════════════════════════════════════════════════
describe('pecClassifyNodeDef contract', () => {
  it('declares branching:true (engine usa chosenBranch per filtrare edge)', () => {
    expect(pecClassifyNodeDef.branching).toBe(true);
  });

  it('declares outputs = 4 PEC categories', () => {
    expect(pecClassifyNodeDef.outputs).toEqual([
      'received_message',
      'acceptance_receipt',
      'delivery_receipt',
      'rejection',
    ]);
  });
});
