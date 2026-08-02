/**
 * webhook-link-normalizer — contract + bug-bounty.
 *
 * Il contract centrale è la GUARIGIONE (il caso Streammy): un link salvato
 * col token del secret VECCHIO (morto) viene convertito in ref, e il ref
 * risolve col token CORRENTE → il link torna vivo senza intervento manuale.
 *
 * Bug-bounty: host estranei intatti, authMode header-token MAI riscritto
 * (il segmento è il secret utente!), customPath ambiguo mai indovinato,
 * token dentro hex più lunghi non matchati, /webhooks/wait/ intatto,
 * strutture annidate, idempotenza alla seconda passata.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeNodesWebhookLinks,
  defaultSameHosts,
  type WebhookOwnerLookup,
} from './webhook-link-normalizer.js';
import { resolveWebhookRefs } from './webhook-ref.js';
import { deriveWebhookTokenFromSecret } from './webhook-token.js';

const OLD_SECRET = 'norm-old-secret-abcdefghijklmnopqrstuv1';
const NEW_SECRET = 'norm-new-secret-abcdefghijklmnopqrstuv2';

const deadToken = (wfId: string) => deriveWebhookTokenFromSecret(OLD_SECRET, wfId);
const liveToken = (wfId: string) => deriveWebhookTokenFromSecret(NEW_SECRET, wfId);

function makeLookup(overrides: Partial<WebhookOwnerLookup> = {}): WebhookOwnerLookup {
  return {
    byId: vi.fn(async (id: string) => ({ id, authMode: 'none' })),
    byCustomPath: vi.fn(async (path: string) =>
      path === 'streammy/search' ? { id: 'wf_search', authMode: 'none' } : null),
    ...overrides,
  };
}

function node(config: Record<string, unknown>): unknown {
  return { id: 'n1', defId: 'action_http', config, x: 0, y: 0 };
}

let ssoBackup: string | undefined;
beforeEach(() => {
  ssoBackup = process.env.MEDEA_SSO_SECRET;
  process.env.MEDEA_SSO_SECRET = NEW_SECRET;
});
afterEach(() => {
  if (ssoBackup === undefined) delete process.env.MEDEA_SSO_SECRET;
  else process.env.MEDEA_SSO_SECRET = ssoBackup;
});

describe('CONTRACT guarigione (il caso Streammy)', () => {
  it('link cablato col token MORTO → ref → risolve col token CORRENTE: il link torna vivo', async () => {
    const nodes = [node({ html: `<a href="/webhooks/c/streammy/search/${deadToken('wf_search')}">Cerca</a>` })];
    const { nodes: out, converted } = await normalizeNodesWebhookLinks(nodes, makeLookup());
    expect(converted).toBe(1);
    const html = (out[0] as { config: { html: string } }).config.html;
    expect(html).toContain('ref://wf/wf_search/webhook/c/streammy/search');
    expect(html).not.toContain(deadToken('wf_search'));
    // La risoluzione (choke-point engine) produce il token VIVO, non quello morto.
    const resolved = resolveWebhookRefs(html);
    expect(resolved).toContain(`/webhooks/c/streammy/search/${liveToken('wf_search')}`);
    expect(resolved).not.toContain(deadToken('wf_search'));
  });

  it('link default-path con query string: ref sostituito chirurgicamente, query intatta', async () => {
    const url = `/webhooks/wf_detail/${deadToken('wf_detail')}?titleId={id}&slug={slug}`;
    const { nodes: out, converted } = await normalizeNodesWebhookLinks([node({ url })], makeLookup());
    expect(converted).toBe(1);
    expect((out[0] as { config: { url: string } }).config.url)
      .toBe('ref://wf/wf_detail/webhook?titleId={id}&slug={slug}');
  });

  it('IDEMPOTENZA: la seconda passata è un no-op totale', async () => {
    const nodes = [node({ html: `<a href="/webhooks/c/streammy/search/${deadToken('wf_search')}">x</a>` })];
    const first = await normalizeNodesWebhookLinks(nodes, makeLookup());
    const second = await normalizeNodesWebhookLinks(first.nodes, makeLookup());
    expect(second.converted).toBe(0);
    expect(second.nodes).toEqual(first.nodes);
  });

  it('stesso target ripetuto N volte = 1 solo lookup, N conversioni', async () => {
    const lookup = makeLookup();
    const t = deadToken('wf_x');
    const nodes = [node({ a: `/webhooks/wf_x/${t}`, b: `vedi /webhooks/wf_x/${t} e /webhooks/wf_x/${t}` })];
    const { converted } = await normalizeNodesWebhookLinks(nodes, lookup);
    expect(converted).toBe(3);
    expect(vi.mocked(lookup.byId)).toHaveBeenCalledTimes(1);
  });
});

describe('conservatività — nel dubbio NON toccare (con motivo registrato)', () => {
  it('authMode header-token: MAI riscritto (il segmento è il secret utente)', async () => {
    const lookup = makeLookup({ byId: vi.fn(async (id: string) => ({ id, authMode: 'header-token' })) });
    const url = `/webhooks/wf_ht/${'a1b2'.repeat(8)}`;
    const { nodes: out, converted, skipped } = await normalizeNodesWebhookLinks([node({ url })], lookup);
    expect(converted).toBe(0);
    expect((out[0] as { config: { url: string } }).config.url).toBe(url);
    expect(skipped.some((s) => s.includes('header-token'))).toBe(true);
  });

  it('customPath ambiguo o inesistente: mai indovinare', async () => {
    const url = `/webhooks/c/percorso/ignoto/${'ab12'.repeat(8)}`;
    const { converted, skipped } = await normalizeNodesWebhookLinks([node({ url })], makeLookup());
    expect(converted).toBe(0);
    expect(skipped.length).toBe(1);
  });

  it('workflow proprietario inesistente (byId null): intatto', async () => {
    const lookup = makeLookup({ byId: vi.fn(async () => null) });
    const url = `/webhooks/wf_ghost/${'cd34'.repeat(8)}`;
    const { converted, skipped } = await normalizeNodesWebhookLinks([node({ url })], lookup);
    expect(converted).toBe(0);
    expect(skipped[0]).toContain('non trovato');
  });

  it('link ASSOLUTO: convertito solo se same-host, host estraneo intatto', async () => {
    const t = deadToken('wf_abs');
    const mine = `https://cucurachi.app.automazionezeli.com/webhooks/wf_abs/${t}`;
    const foreign = `https://altro-tenant.example.com/webhooks/wf_abs/${t}`;
    const { nodes: out, converted, skipped } = await normalizeNodesWebhookLinks(
      [node({ mine, foreign })],
      makeLookup(),
      { sameHosts: ['cucurachi.app.automazionezeli.com'] },
    );
    expect(converted).toBe(1);
    const cfg = (out[0] as { config: { mine: string; foreign: string } }).config;
    expect(cfg.mine).toBe('ref://wf/wf_abs/webhook');
    expect(cfg.foreign).toBe(foreign);
    expect(skipped.some((s) => s.includes('altro-tenant.example.com'))).toBe(true);
  });

  it('senza sameHosts configurati, OGNI link assoluto resta intatto (fail-safe)', async () => {
    const url = `https://x.example.com/webhooks/wf_a/${'ef56'.repeat(8)}`;
    const { converted } = await normalizeNodesWebhookLinks([node({ url })], makeLookup());
    expect(converted).toBe(0);
  });
});

describe('bug-bounty — pattern ostili', () => {
  it('token dentro hex PIÙ LUNGO di 32 non matcha (niente conversioni parziali)', async () => {
    const url = `/webhooks/wf_a/${'a'.repeat(33)}`;
    const { converted } = await normalizeNodesWebhookLinks([node({ url })], makeLookup());
    expect(converted).toBe(0);
  });

  it('/webhooks/wait/<token> (resume endpoint) e /webhooks/c/ senza token: intatti', async () => {
    const cfg = {
      wait: `/webhooks/wait/${'ab'.repeat(16)}`,
      noToken: '/webhooks/c/solo/percorso',
      partial: '/webhooks/',
    };
    const { nodes: out, converted } = await normalizeNodesWebhookLinks([node(cfg)], makeLookup());
    expect(converted).toBe(0);
    expect((out[0] as { config: typeof cfg }).config).toEqual(cfg);
  });

  it('strutture annidate (array/oggetti/misti) convertite in profondità, tipi non-stringa preservati', async () => {
    const t = deadToken('wf_deep');
    const nodes = [node({
      lista: [{ url: `/webhooks/wf_deep/${t}` }, 42, null, true],
      annidato: { livello2: { html: `x /webhooks/wf_deep/${t} y` } },
      numero: 7,
    })];
    const { nodes: out, converted } = await normalizeNodesWebhookLinks(nodes, makeLookup());
    expect(converted).toBe(2);
    const cfg = (out[0] as { config: Record<string, unknown> }).config;
    expect((cfg.lista as unknown[])[0]).toEqual({ url: 'ref://wf/wf_deep/webhook' });
    expect((cfg.lista as unknown[]).slice(1)).toEqual([42, null, true]);
    expect((cfg.annidato as { livello2: { html: string } }).livello2.html).toBe('x ref://wf/wf_deep/webhook y');
    expect(cfg.numero).toBe(7);
  });

  it('nodes senza alcun /webhooks/: ritorno identico per riferimento (fast-path)', async () => {
    const lookup = makeLookup();
    const nodes = [node({ url: 'https://api.example.com/x' })];
    const out = await normalizeNodesWebhookLinks(nodes, lookup);
    expect(out.nodes).toBe(nodes);
    expect(vi.mocked(lookup.byId)).not.toHaveBeenCalled();
    expect(vi.mocked(lookup.byCustomPath)).not.toHaveBeenCalled();
  });
});

describe('defaultSameHosts — host del tenant dall\'env di provisioning', () => {
  const backup: Record<string, string | undefined> = {};
  beforeEach(() => {
    backup.MEDEA_PUBLIC_BASE_URL = process.env.MEDEA_PUBLIC_BASE_URL;
    backup.CORS_ORIGINS = process.env.CORS_ORIGINS;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('unisce base URL + CORS origins, dedup, lowercase, ignora origin malformate', () => {
    process.env.MEDEA_PUBLIC_BASE_URL = 'https://Cucurachi.app.automazionezeli.com';
    process.env.CORS_ORIGINS = 'https://cucurachi.app.automazionezeli.com, https://flowforge.automazionezeli.com, non-un-url,';
    const hosts = defaultSameHosts();
    expect(hosts).toContain('cucurachi.app.automazionezeli.com');
    expect(hosts).toContain('flowforge.automazionezeli.com');
    expect(hosts).toHaveLength(2);
  });

  it('senza env: lista vuota (nessun assoluto convertibile — fail-safe)', () => {
    delete process.env.MEDEA_PUBLIC_BASE_URL;
    delete process.env.CORS_ORIGINS;
    expect(defaultSameHosts()).toEqual([]);
  });
});
