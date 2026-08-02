/**
 * `action_email_triage` — executor tests.
 *
 * Coverage:
 *   • input path resolution (root + dotted)
 *   • output shape (sender / subject / body / attachments / flags)
 *   • bodyMaxChars propagation to the lib
 *   • input guard (missing → ValidationError)
 *   • pipelineSteps emission with truncation flag
 */

import { describe, it, expect } from 'vitest';
import { emailTriageExecutor } from './executor.js';
import { ValidationError } from '../../core/node-error.js';

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} };

const SAMPLE = {
  from: '"Mario Rossi" <Mario@StudioComm.IT>',
  subject: 'Re: Fw: Sollecito fattura urgente',
  body:
    'Buongiorno, le scrivo per sollecitare il pagamento della fattura. ' +
    'La scadenza era il 30 maggio. Vi ringrazio per la pronta risposta.',
  headers: {
    'X-Trasporto': 'posta-certificata',
    'X-Ricevuta': undefined,
    Subject: 'Re: Fw: Sollecito fattura urgente',
  },
  attachments: [{ filename: 'fattura.pdf', mimeType: 'application/pdf', sizeBytes: 12_000 }],
  messageId: '<abc123@studiocomm.example.it>',
};

describe('emailTriageExecutor — happy path', () => {
  it('shapes the output with sender + subject + flags', async () => {
    const out = await emailTriageExecutor({}, SAMPLE, ctx);
    const o = out.output as Record<string, unknown>;
    expect(o.senderEmail).toBe('mario@studiocomm.it');
    expect(o.senderDomain).toBe('studiocomm.it');
    expect(o.subjectClean).toBe('Sollecito fattura urgente');
    expect(o.isPec).toBe(true);
    expect((o.urgencySignals as readonly string[]).includes('scadenza')).toBe(true);
    expect((o.attachments as { count: number }).count).toBe(1);
    expect(o.messageId).toBe('<abc123@studiocomm.example.it>');
  });

  it('propagates bodyMaxChars', async () => {
    const long = { from: 'a@b.it', body: 'x'.repeat(5000) };
    const out = await emailTriageExecutor({ bodyMaxChars: 200 }, long, ctx);
    const o = out.output as Record<string, unknown>;
    expect((o.bodyTextShort as string).length).toBeLessThanOrEqual(201);
    expect(o.bodyTextOriginalLength).toBe(5000);
  });
});

describe('emailTriageExecutor — input path', () => {
  it('resolves a dotted inputPath', async () => {
    const out = await emailTriageExecutor({ inputPath: 'mail' }, { mail: SAMPLE }, ctx);
    expect((out.output as Record<string, unknown>).senderEmail).toBe('mario@studiocomm.it');
  });

  it('throws ValidationError when no email is found at the path', async () => {
    await expect(
      emailTriageExecutor({ inputPath: 'mail' }, { other: SAMPLE }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('emailTriageExecutor — pipelineSteps', () => {
  it('reports truncated=true when body exceeded the cap', async () => {
    const long = { from: 'a@b.it', body: 'x'.repeat(5000) };
    const out = await emailTriageExecutor({ bodyMaxChars: 200 }, long, ctx);
    const steps = (out.output as Record<string, unknown>).pipelineSteps as Record<
      string,
      unknown
    >[];
    expect((steps[0]?.evidence as Record<string, unknown>).truncated).toBe(true);
  });

  it('omits pipelineSteps when includePipelineLog=false', async () => {
    const out = await emailTriageExecutor({ includePipelineLog: false }, SAMPLE, ctx);
    expect((out.output as Record<string, unknown>).pipelineSteps).toBeUndefined();
  });
});
