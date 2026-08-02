/**
 * webhook-ref — contract test dell'indirection.
 *
 * I due contract ISTITUZIONALIZZATI dal post-mortem Streammy:
 *   1. ref→URL CORRETTO dopo rotazione del secret (il ref sopravvive, il
 *      token cablato no) — è il test che FALLISCE sul mondo pre-fix.
 *   2. il choke-point interpolateConfig risolve i ref in OGNI stringa di
 *      config, anche quelle prodotte da espressioni {{…}}.
 *
 * Più bug-bounty: ref malformati/injection lasciati intatti, ref immersi in
 * HTML/JSON/query-string, charset ostile, secret assente (fail-visible).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildWebhookRef,
  parseWebhookRef,
  buildWebhookPathFromRef,
  resolveWebhookRefs,
} from './webhook-ref.js';
import { deriveDefaultWebhookToken, deriveWebhookTokenFromSecret } from './webhook-token.js';
import { interpolateConfig, type InterpreterScope } from '@/engine/interpreter.js';

const SECRET_A = 'ref-secret-A-abcdefghijklmnopqrstuvwxyz1';
const SECRET_B = 'ref-secret-B-abcdefghijklmnopqrstuvwxyz2';
const WF = 'streammy_search_wf1';

let ssoBackup: string | undefined;

beforeEach(() => {
  ssoBackup = process.env.MEDEA_SSO_SECRET;
  process.env.MEDEA_SSO_SECRET = SECRET_A;
});

afterEach(() => {
  if (ssoBackup === undefined) delete process.env.MEDEA_SSO_SECRET;
  else process.env.MEDEA_SSO_SECRET = ssoBackup;
});

describe('buildWebhookRef / parseWebhookRef — roundtrip', () => {
  it('default path: build → parse è identità', () => {
    const ref = { workflowId: WF };
    expect(buildWebhookRef(ref)).toBe(`ref://wf/${WF}/webhook`);
    expect(parseWebhookRef(buildWebhookRef(ref))).toEqual(ref);
  });

  it('custom path multi-segmento: roundtrip preservato', () => {
    const ref = { workflowId: WF, customPath: 'streammy/search' };
    expect(buildWebhookRef(ref)).toBe(`ref://wf/${WF}/webhook/c/streammy/search`);
    expect(parseWebhookRef(buildWebhookRef(ref))).toEqual(ref);
  });

  it('build rifiuta input fuori schema (Zod throw, non silenzio)', () => {
    expect(() => buildWebhookRef({ workflowId: '../../../etc/passwd' })).toThrow();
    expect(() => buildWebhookRef({ workflowId: WF, customPath: 'a//b' })).toThrow();
    expect(() => buildWebhookRef({ workflowId: '' })).toThrow();
  });

  it('parse severo: testo attorno, scheme errato, charset ostile → null', () => {
    expect(parseWebhookRef(`x ref://wf/${WF}/webhook`)).toBeNull();
    expect(parseWebhookRef(`ref://wf/${WF}/webhook estra`)).toBeNull();
    expect(parseWebhookRef('ref://wf//webhook')).toBeNull();
    expect(parseWebhookRef('ref://wf/<script>/webhook')).toBeNull();
    expect(parseWebhookRef('REF://wf/x/webhook')).toBeNull();
    expect(parseWebhookRef('')).toBeNull();
  });
});

describe('buildWebhookPathFromRef — token dal secret CORRENTE', () => {
  it('default path col token derivato', () => {
    const token = deriveDefaultWebhookToken(WF);
    expect(buildWebhookPathFromRef({ workflowId: WF })).toBe(`/webhooks/${WF}/${token}`);
  });

  it('custom path: il token deriva dal workflowId PROPRIETARIO, il path resta custom', () => {
    const token = deriveDefaultWebhookToken(WF);
    expect(buildWebhookPathFromRef({ workflowId: WF, customPath: 'streammy/search' }))
      .toBe(`/webhooks/c/streammy/search/${token}`);
  });

  it('fail-visible: senza secret → null (mai un token fasullo)', () => {
    delete process.env.MEDEA_SSO_SECRET;
    expect(buildWebhookPathFromRef({ workflowId: WF })).toBeNull();
  });
});

describe('resolveWebhookRefs — CONTRACT rotazione (il fix Streammy)', () => {
  it('lo stesso ref risolve a token DIVERSI prima e dopo la rotazione — il link non si rompe mai', () => {
    const ref = buildWebhookRef({ workflowId: WF, customPath: 'streammy/search' });
    const before = resolveWebhookRefs(ref);
    process.env.MEDEA_SSO_SECRET = SECRET_B; // rotazione secret
    const after = resolveWebhookRefs(ref);
    expect(before).toBe(`/webhooks/c/streammy/search/${deriveWebhookTokenFromSecret(SECRET_A, WF)}`);
    expect(after).toBe(`/webhooks/c/streammy/search/${deriveWebhookTokenFromSecret(SECRET_B, WF)}`);
    expect(after).not.toBe(before); // il token cablato `before` sarebbe MORTO: il ref no
  });

  it('ref immerso in HTML con query string: sostituzione chirurgica, suffisso intatto', () => {
    const ref = buildWebhookRef({ workflowId: WF, customPath: 'streammy/title' });
    const html = `<a href="${ref}?titleId={id}&slug={slug}">Apri</a>`;
    const out = resolveWebhookRefs(html);
    const token = deriveDefaultWebhookToken(WF);
    expect(out).toBe(`<a href="/webhooks/c/streammy/title/${token}?titleId={id}&slug={slug}">Apri</a>`);
  });

  it('più ref di workflow DIVERSI nello stesso testo: ognuno col SUO token', () => {
    const text = `search: ref://wf/wf_search/webhook — detail: ref://wf/wf_detail/webhook/c/streammy/title`;
    const out = resolveWebhookRefs(text);
    expect(out).toContain(`/webhooks/wf_search/${deriveDefaultWebhookToken('wf_search')}`);
    expect(out).toContain(`/webhooks/c/streammy/title/${deriveDefaultWebhookToken('wf_detail')}`);
    expect(out).not.toContain('ref://');
  });

  it('ref dentro JSON serializzato (config salvata) risolto senza rompere il JSON', () => {
    const ref = buildWebhookRef({ workflowId: WF });
    const json = JSON.stringify({ url: ref, note: 'testo con ref://wf non completo' });
    const out = resolveWebhookRefs(json);
    const parsed = JSON.parse(out) as { url: string; note: string };
    expect(parsed.url).toBe(`/webhooks/${WF}/${deriveDefaultWebhookToken(WF)}`);
    expect(parsed.note).toBe('testo con ref://wf non completo'); // malformato → intatto
  });

  it('bug-bounty: scheme incompleto/charset ostile NON viene toccato né crasha', () => {
    const hostile = [
      'ref://wf//webhook',
      'ref://wf/../../etc/webhook',
      'ref://wf/ok!id/webhook',
      'ref://wf/',
      'testo normale senza ref',
      '',
    ];
    for (const t of hostile) {
      expect(resolveWebhookRefs(t)).toBe(t);
    }
  });

  it('fail-visible: senza secret il ref resta simbolico nel testo (mai token inventato)', () => {
    delete process.env.MEDEA_SSO_SECRET;
    const ref = buildWebhookRef({ workflowId: WF });
    expect(resolveWebhookRefs(`link: ${ref}`)).toBe(`link: ${ref}`);
  });
});

describe('interpolateConfig — choke-point contract (engine)', () => {
  const scope: InterpreterScope = { vars: { wfId: WF } };

  it('risolve i ref in ogni stringa di config (il punto per cui gli executor non vedono MAI un ref)', () => {
    const ref = buildWebhookRef({ workflowId: WF, customPath: 'streammy/search' });
    const out = interpolateConfig({ body: `<a href="${ref}">cerca</a>`, other: 42 }, scope);
    expect(out.body).toContain(`/webhooks/c/streammy/search/${deriveDefaultWebhookToken(WF)}`);
    expect(out.body).not.toContain('ref://');
    expect(out.other).toBe(42);
  });

  it('risolve anche i ref PRODOTTI da un\'espressione {{…}} (ordine: prima interpolazione, poi resolver)', () => {
    const out = interpolateConfig({ url: `ref://wf/{{vars.wfId}}/webhook` }, scope);
    expect(out.url).toBe(`/webhooks/${WF}/${deriveDefaultWebhookToken(WF)}`);
  });
});
