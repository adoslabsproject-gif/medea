/**
 * Test del nodo `action_email_clean` (executor).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { NodeExecutionContext } from '../../types.js';
import { emailCleanActionNode } from './index.js';
import { ValidationError } from '../../core/node-error.js';

function ctx(): NodeExecutionContext {
  return {
    workflowId: 'wf', runId: 'r', nodeId: 'n', tenantId: 't',
    userId: 'u', logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
}

describe('emailCleanExecutor', () => {
  it('pass-through preserves subject/from while replacing body', async () => {
    const input = {
      subject: 'RE: documenti',
      from: 'mario@x.it',
      body: 'Vi mando i doc.\n\n-- \nMario',
    };
    const r = await emailCleanActionNode.executor({}, input, ctx());
    const o = r.output as Record<string, unknown>;
    expect(o.subject).toBe('RE: documenti');
    expect(o.from).toBe('mario@x.it');
    expect(o.body).toBe('Vi mando i doc.');
    const rep = o.cleanReport as Record<string, unknown>;
    expect(rep.removedSignature).toBe(true);
    expect(rep.reductionRatio as number).toBeLessThan(1);
  });

  it('accepts a bare string input', async () => {
    const r = await emailCleanActionNode.executor({}, 'Solo testo', ctx());
    const o = r.output as Record<string, unknown>;
    expect(o.body).toBe('Solo testo');
  });

  it('unwraps { output: {...} } nested input', async () => {
    const r = await emailCleanActionNode.executor({},
      { output: { subject: 'X', body: 'Ciao\n\n-- \nA' } }, ctx());
    const o = r.output as Record<string, unknown>;
    expect(o.subject).toBe('X');
    expect(o.body).toBe('Ciao');
  });

  it('respects inputBodyField=text', async () => {
    const input = { text: 'hello\n\n-- \nA', meta: 'keep me' };
    const r = await emailCleanActionNode.executor({ inputBodyField: 'text' }, input, ctx());
    const o = r.output as Record<string, unknown>;
    expect(o.text).toBe('hello');
    expect(o.meta).toBe('keep me');
  });

  it('respects flags: all strippers disabled = body unchanged', async () => {
    const body = 'Hi\n\n-- \nSig\n\nOn 2026-01-15, X wrote:\n> q\n\nThis email is confidential.';
    const r = await emailCleanActionNode.executor({
      stripQuotedReply: false, stripSignatures: false,
      stripDisclaimers: false, collapseBlankLines: false,
    }, { body }, ctx());
    expect((r.output as Record<string, string>).body).toBe(body);
  });

  it('warns when cleaner drops the entire body', async () => {
    // 100% disclaimer
    const body = 'This email and any attachments are confidential and intended solely for the addressee. ' + 'x'.repeat(200);
    const r = await emailCleanActionNode.executor({}, { body }, ctx());
    expect(r.warnings).toBeDefined();
  });

  it('throws ValidationError when body field missing', async () => {
    await expect(emailCleanActionNode.executor({}, { subject: 'X' }, ctx()))
      .rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when input is null', async () => {
    await expect(emailCleanActionNode.executor({}, null, ctx()))
      .rejects.toThrow(ValidationError);
  });

  it('integration: realistic 800-char body shrunk to ~30 chars', async () => {
    const body = [
      'Buongiorno, vi mando i documenti per il 730.',
      'Grazie. Mario.',
      '',
      '-- ',
      'Mario Rossi - Studio Tributario',
      'Via X 12, 00100 Roma',
      'Tel: 06 12345 - Mobile: 333 1234567',
      'P.IVA: 12345678901',
      '',
      'Per proteggere l\'ambiente non stampare questo messaggio.',
      '',
      'Il giorno 15 gennaio 2026 14:32, Anna Bianchi ha scritto:',
      '> Buongiorno Mario, ti chiedo cortesemente la dichiarazione 2025.',
      '> Grazie.',
    ].join('\n');
    const r = await emailCleanActionNode.executor({}, { body }, ctx());
    const o = r.output as Record<string, unknown>;
    const rep = o.cleanReport as Record<string, unknown>;
    expect((o.body as string).length).toBeLessThan(120);
    expect(o.body).toContain('730');
    expect(rep.removedQuotedReply).toBe(true);
    expect(rep.removedSignature).toBe(true);
    expect(rep.reductionRatio as number).toBeLessThan(0.3);
  });

  it('truncates at maxBodyLength', async () => {
    const body = 'a'.repeat(10_000);
    const r = await emailCleanActionNode.executor({ maxBodyLength: 100 }, { body }, ctx());
    expect((r.output as Record<string, string>).body.length).toBe(101); // 100 + …
  });
});
