/**
 * webhook-link-normalizer — converte i link webhook CABLATI (col token
 * derivato dentro l'URL) nel riferimento simbolico `ref://` (indirection,
 * vedi `lib/webhook-ref.ts`).
 *
 * È la GUARDIA del contract "un workflow salvato non contiene MAI un token
 * cablato": gira sul path di salvataggio (WorkflowService.create/update) e
 * nella migrazione idempotente al boot (webhook-ref-migration.service.ts).
 *
 * Regole di conversione (conservative: nel dubbio NON toccare, registra):
 *   • si convertono SOLO link il cui workflow proprietario esiste in questo
 *     container e ha trigger_webhook con authMode `none` — negli altri modi
 *     il segmento token del path non è derivato (header-token = secret
 *     utente!) e riscriverlo ROMPEREBBE l'auth;
 *   • link ASSOLUTI: convertiti solo se l'host è di questo tenant
 *     (`sameHosts`) — un URL verso un altro container non è risolvibile qui;
 *   • custom path: proprietario risolto per lookup ESATTO; 0 o >1 match →
 *     skip (mai indovinare);
 *   • il resolver emette path RELATIVI: la perdita dell'host sui link
 *     same-host è voluta (le pagine sono servite dallo stesso host).
 *
 * Idempotente per costruzione: un `ref://` non matcha i pattern cablati,
 * quindi la seconda passata è sempre no-op.
 */

import { buildWebhookRef, WebhookRefSchema } from './webhook-ref.js';

/** Proprietario di un webhook: id workflow + authMode del trigger (già defaultato a `none`). */
export interface WebhookLinkTarget {
  id: string;
  authMode: string;
}

/** Lookup del proprietario — implementato da WorkflowService, iniettato per testabilità. */
export interface WebhookOwnerLookup {
  byId(workflowId: string): Promise<WebhookLinkTarget | null>;
  /** null se il customPath non esiste O è ambiguo (>1 workflow). */
  byCustomPath(customPath: string): Promise<WebhookLinkTarget | null>;
}

export interface NormalizeNodesOutcome {
  nodes: unknown[];
  /** Numero di occorrenze convertite in ref. */
  converted: number;
  /** Link lasciati intatti, con motivo — per log/report onesto, mai silenzio. */
  skipped: string[];
}

/** Host+scheme opzionale davanti al path (gruppo 1 = host, lowercase al confronto). */
const HOST_PART = String.raw`(?:https?:\/\/([^/\s"'<>\\]+))?`;
/** Token cablato: 32 hex, non seguito da altro alfanumerico (evita match dentro id lunghi). */
const TOKEN_PART = String.raw`([a-f0-9]{32})(?![A-Za-z0-9])`;

const CUSTOM_LINK_RE = new RegExp(
  `${HOST_PART}\\/webhooks\\/c\\/((?:[A-Za-z0-9._~-]+\\/)*[A-Za-z0-9._~-]+)\\/${TOKEN_PART}`,
  'gu',
);
const DEFAULT_LINK_RE = new RegExp(
  `${HOST_PART}\\/webhooks\\/(?!c\\/|wait\\/)([A-Za-z0-9][A-Za-z0-9_-]{0,63})\\/${TOKEN_PART}`,
  'gu',
);

/** Applica `fn` a ogni stringa dentro un albero JSON-like, preservando la struttura. */
function deepMapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepMapStrings(v, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepMapStrings(v, fn);
    }
    return out;
  }
  return value;
}

/** Decisione per un target: il ref da sostituire, o il motivo dello skip. */
type Decision = { ref: string } | { skip: string };

function decideFromTarget(
  target: WebhookLinkTarget | null,
  describe: string,
  customPath?: string,
): Decision {
  if (!target) return { skip: `${describe}: workflow proprietario non trovato o ambiguo` };
  if (target.authMode !== 'none') {
    return {
      skip: `${describe}: authMode "${target.authMode}" — il segmento token non è derivato, non riscrivibile`,
    };
  }
  const candidate =
    customPath !== undefined ? { workflowId: target.id, customPath } : { workflowId: target.id };
  if (!WebhookRefSchema.safeParse(candidate).success) {
    return { skip: `${describe}: fuori charset dello schema ref` };
  }
  return { ref: buildWebhookRef(candidate) };
}

/**
 * Normalizza i link cablati dentro l'albero `nodes` di un workflow.
 * Due fasi: (1) scan del serializzato per raccogliere i target unici e
 * risolverli via lookup asincrono; (2) sostituzione sincrona per-stringa
 * con le decisioni già prese. Un solo lookup per target, qualunque sia il
 * numero di occorrenze.
 */
export async function normalizeNodesWebhookLinks(
  nodes: unknown[],
  lookup: WebhookOwnerLookup,
  opts: { sameHosts?: readonly string[] } = {},
): Promise<NormalizeNodesOutcome> {
  const serialized = JSON.stringify(nodes);
  if (!serialized.includes('/webhooks/')) return { nodes, converted: 0, skipped: [] };

  const sameHosts = new Set((opts.sameHosts ?? []).map((h) => h.toLowerCase()));

  // ── Fase 1: raccolta target unici + lookup ──────────────────────────
  const customPaths = new Set<string>();
  const workflowIds = new Set<string>();
  for (const m of serialized.matchAll(CUSTOM_LINK_RE)) customPaths.add(m[2]!);
  for (const m of serialized.matchAll(DEFAULT_LINK_RE)) workflowIds.add(m[2]!);

  const customDecisions = new Map<string, Decision>();
  for (const path of customPaths) {
    customDecisions.set(
      path,
      decideFromTarget(await lookup.byCustomPath(path), `/webhooks/c/${path}/…`, path),
    );
  }
  const idDecisions = new Map<string, Decision>();
  for (const id of workflowIds) {
    idDecisions.set(id, decideFromTarget(await lookup.byId(id), `/webhooks/${id}/…`));
  }

  // ── Fase 2: sostituzione sincrona ───────────────────────────────────
  let converted = 0;
  const skipped = new Set<string>();

  const hostAllowed = (host: string | undefined): boolean =>
    host === undefined || sameHosts.has(host.toLowerCase());

  const applyDecision = (
    whole: string,
    host: string | undefined,
    decision: Decision | undefined,
    describe: string,
  ): string => {
    if (!decision) return whole; // impossibile per costruzione (scan e replace usano lo stesso regex)
    if (!hostAllowed(host)) {
      skipped.add(`${describe}: host "${host ?? ''}" non è di questo tenant`);
      return whole;
    }
    if ('skip' in decision) {
      skipped.add(decision.skip);
      return whole;
    }
    converted += 1;
    return decision.ref;
  };

  const normalizeString = (s: string): string => {
    if (!s.includes('/webhooks/')) return s;
    let out = s.replace(CUSTOM_LINK_RE, (whole, host: string | undefined, path: string) =>
      applyDecision(whole, host, customDecisions.get(path), `/webhooks/c/${path}/…`),
    );
    out = out.replace(DEFAULT_LINK_RE, (whole, host: string | undefined, id: string) =>
      applyDecision(whole, host, idDecisions.get(id), `/webhooks/${id}/…`),
    );
    return out;
  };

  const mapped = deepMapStrings(nodes, normalizeString) as unknown[];
  return { nodes: mapped, converted, skipped: [...skipped] };
}

/**
 * Host di QUESTO tenant, derivati dall'env di provisioning: il subdomain
 * pubblico (MEDEA_PUBLIC_BASE_URL) + le CORS origins iniettate da
 * onboarding.ts. Un link assoluto verso uno di questi host è "nostro" e può
 * diventare ref relativo.
 */
export function defaultSameHosts(): string[] {
  const hosts = new Set<string>();
  const push = (raw: string): void => {
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch {
      /* origin malformata: ignora, il link resterà skippato (conservativo) */
    }
  };
  const base = process.env.MEDEA_PUBLIC_BASE_URL ?? '';
  if (base) push(base);
  for (const origin of (process.env.CORS_ORIGINS ?? '').split(',')) {
    const trimmed = origin.trim();
    if (trimmed) push(trimmed);
  }
  return [...hosts];
}
