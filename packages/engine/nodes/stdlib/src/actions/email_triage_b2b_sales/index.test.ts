/**
 * `agent_email_triage_b2b_sales` — node tests.
 *
 * The deep classification correctness lives in `lib/email/triage-b2b-sales.test.ts`.
 * Here we cover the node-level wiring: config parsing, input shape unwrapping,
 * minConfidence override, NodeDef contract.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  emailTriageB2BSalesNode,
  emailTriageB2BSalesNodeDef,
  emailTriageB2BSalesExecutor,
  EmailTriageB2BSalesConfigSchema,
} from './index.js';

const ctx = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as const;

describe('NodeDef contract', () => {
  it('has the stable id + type + label', () => {
    expect(emailTriageB2BSalesNodeDef.id).toBe('agent_email_triage_b2b_sales');
    expect(emailTriageB2BSalesNodeDef.type).toBe('action');
    expect(typeof emailTriageB2BSalesNodeDef.label).toBe('string');
  });

  it('exposes the executor via NodeModule', () => {
    expect(emailTriageB2BSalesNode.executor).toBe(emailTriageB2BSalesExecutor);
  });

  it('all configFields have help text', () => {
    for (const f of emailTriageB2BSalesNodeDef.configFields ?? []) {
      expect(typeof f.help).toBe('string');
      expect((f.help!).length).toBeGreaterThan(10);
    }
  });
});

describe('schema', () => {
  it('defaults subjectField/bodyField/fromField + auto language', () => {
    const r = EmailTriageB2BSalesConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.subjectField).toBe('subject');
      expect(r.data.bodyField).toBe('body');
      expect(r.data.fromField).toBe('from');
      expect(r.data.lang).toBe('auto');
      expect(r.data.minConfidence).toBe(0.7);
    }
  });

  it('honors lang override', () => {
    const r = EmailTriageB2BSalesConfigSchema.safeParse({ lang: 'en' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lang).toBe('en');
  });

  it('rejects out-of-range minConfidence', () => {
    expect(EmailTriageB2BSalesConfigSchema.safeParse({ minConfidence: 1.2 }).success).toBe(false);
    expect(EmailTriageB2BSalesConfigSchema.safeParse({ minConfidence: -0.1 }).success).toBe(false);
  });
});

describe('executor — happy paths', () => {
  it('classifies an Italian "listino" reply as interested_info', async () => {
    const res = await emailTriageB2BSalesExecutor({}, {
      subject: 'Re: Redivivo',
      body: 'Buongiorno, mi mandate il listino e il catalogo aggiornati? Grazie',
      from: 'mario@enoteca.it',
    }, ctx);
    const out = res.output as { label: string; suggestedAction: string; language: string };
    expect(out.label).toBe('interested_info');
    expect(out.suggestedAction).toBe('send_catalog');
    expect(out.language).toBe('it');
  });

  it('classifies an English "tasting" reply', async () => {
    const res = await emailTriageB2BSalesExecutor({ lang: 'en' }, {
      subject: 'Re: Sample',
      body: 'Could we get a tasting sample? Thanks the and to for',
      from: 'jane@bar.uk',
    }, ctx);
    const out = res.output as { label: string };
    expect(out.label).toBe('interested_tasting');
  });

  it('routes unknown content to needs_human_review with confidence < threshold', async () => {
    const res = await emailTriageB2BSalesExecutor({}, {
      subject: '',
      body: 'Hi.',
      from: 'someone@x.it',
    }, ctx);
    const out = res.output as { label: string; suggestedAction: string };
    expect(out.label).toBe('needs_human_review');
    expect(out.suggestedAction).toBe('forward_to_human');
  });

  it('strict minConfidence downgrades a borderline match', async () => {
    // A body with a single weak match → confidence likely around 0.5-0.7.
    // With minConfidence=0.99 the result is downgraded.
    const res = await emailTriageB2BSalesExecutor({ minConfidence: 0.99 }, {
      subject: 'Re',
      body: 'sample',
      from: 'x@y.it',
    }, ctx);
    const out = res.output as { label: string };
    expect(out.label).toBe('needs_human_review');
  });
});

describe('executor — input shape', () => {
  it('accepts custom subjectField / bodyField / fromField', async () => {
    const res = await emailTriageB2BSalesExecutor(
      { subjectField: 'mail_subj', bodyField: 'mail_body', fromField: 'sender' },
      {
        mail_subj: 'Listino',
        mail_body: 'mandatemi il listino e catalogo',
        sender: 'a@b.it',
      },
      ctx,
    );
    const out = res.output as { label: string };
    expect(out.label).toBe('interested_info');
  });

  it('unwraps an upstream `output: {...}` envelope when present', async () => {
    const res = await emailTriageB2BSalesExecutor({}, {
      output: {
        subject: 'Re: Listino',
        body: 'listino aggiornato per favore',
        from: 'x@y.it',
      },
    }, ctx);
    const out = res.output as { label: string };
    expect(out.label).toBe('interested_info');
  });

  it('keeps the original input fields in the output (extension shape)', async () => {
    const res = await emailTriageB2BSalesExecutor({}, {
      subject: 'Re: x',
      body: 'mandatemi il listino e catalogo',
      from: 'x@y.it',
      messageId: 'mid-123',
    }, ctx);
    const out = res.output as Record<string, unknown>;
    expect(out.messageId).toBe('mid-123');
    expect(out.label).toBe('interested_info');
  });
});
