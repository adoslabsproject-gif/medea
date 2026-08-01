/**
 * webhook-ref — INDIRECTION per i link webhook interni ai workflow.
 *
 * PRINCIPIO (post-mortem Streammy 2026-07): MAI cablare un valore DERIVATO.
 * Il token webhook di default è derivato dal secret del container
 * (`lib/webhook-token.ts`): un link salvato nel workflow col token dentro
 * si rompe a ogni rotazione del secret. Da qui il riferimento simbolico:
 *
 *     ref://wf/<workflowId>/webhook                → /webhooks/<workflowId>/<token>
 *     ref://wf/<workflowId>/webhook/c/<customPath> → /webhooks/c/<customPath>/<token>
 *
 * Il ref è STABILE (dipende solo dall'identità del workflow, versionabile,
 * export/import-safe); il RESOLVER lo espande al momento dell'uso col token
 * derivato dal secret CORRENTE — il secret può ruotare senza rompere nulla.
 *
 * Choke-point di risoluzione: `interpolateConfig` (engine/interpreter.ts) —
 * ogni stringa di config passa di lì prima di raggiungere un executor, quindi
 * qualunque nodo (template HTML, respond, http, email) vede l'URL già risolto.
 *
 * Il resolver emette path RELATIVI: i link interni vivono in pagine servite
 * dallo stesso host del webhook (contratto documentato nel normalizzatore,
 * che converte in ref solo link relativi o same-host).
 */

import { z } from 'zod';
import { deriveDefaultWebhookToken } from './webhook-token.js';
import { dedupedWarn } from './logger.js';

/** Charset id workflow: nanoid default (A-Za-z0-9_-) + id legacy tipo `streammy_search_wf1`. */
const WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** Charset segmento customPath: URL-safe unreserved (niente slash — i segmenti si uniscono con '/'). */
const CUSTOM_PATH_RE = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;

/** Riferimento simbolico validato — l'unica forma che può essere persistita nei workflow. */
export const WebhookRefSchema = z.object({
  workflowId: z.string().regex(WORKFLOW_ID_RE),
  customPath: z.string().regex(CUSTOM_PATH_RE).max(200).optional(),
});
export type WebhookRef = z.infer<typeof WebhookRefSchema>;

/**
 * Scanner globale dei ref dentro testo libero. Il gruppo customPath si ferma
 * al primo carattere fuori charset (quote, spazio, `?`, `#`, `<` …) così un
 * ref dentro HTML/JSON/query-string viene catturato senza mangiarsi il resto.
 */
const REF_SCAN_RE = /ref:\/\/wf\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/webhook(?:\/c\/((?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+))?/gu;

/** Serializza un ref validato nella forma canonica `ref://…`. */
export function buildWebhookRef(ref: WebhookRef): string {
  const parsed = WebhookRefSchema.parse(ref);
  return parsed.customPath
    ? `ref://wf/${parsed.workflowId}/webhook/c/${parsed.customPath}`
    : `ref://wf/${parsed.workflowId}/webhook`;
}

/**
 * Parse severo di una stringa che DEVE essere esattamente un ref (niente
 * testo attorno). Ritorna null su qualsiasi input non conforme.
 */
export function parseWebhookRef(text: string): WebhookRef | null {
  const re = new RegExp(`^${REF_SCAN_RE.source}$`, 'u');
  const m = re.exec(text);
  if (!m) return null;
  const candidate: WebhookRef = m[2] !== undefined
    ? { workflowId: m[1]!, customPath: m[2] }
    : { workflowId: m[1]! };
  const parsed = WebhookRefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Path pubblico CORRENTE per un ref: token ricalcolato dal secret corrente
 * a ogni chiamata (mai memoizzato — è il punto del fix). Ritorna null se il
 * secret manca (dev senza env): meglio un ref visibile non risolto che un
 * link con token fasullo copiabile.
 */
export function buildWebhookPathFromRef(ref: WebhookRef): string | null {
  const token = deriveDefaultWebhookToken(ref.workflowId);
  if (token === '') return null;
  return ref.customPath
    ? `/webhooks/c/${ref.customPath}/${token}`
    : `/webhooks/${ref.workflowId}/${token}`;
}

/**
 * Sostituisce OGNI occorrenza di ref dentro un testo col path corrente.
 * Testo senza ref torna identico (fast-path senza regex globale).
 * Ref non risolvibile (secret assente) resta intatto + warn dedup-ato:
 * fail-visible, mai fail-fabricated.
 */
export function resolveWebhookRefs(text: string): string {
  if (!text.includes('ref://wf/')) return text;
  return text.replace(REF_SCAN_RE, (whole, workflowId: string, customPath: string | undefined) => {
    const candidate: WebhookRef = customPath !== undefined ? { workflowId, customPath } : { workflowId };
    const parsed = WebhookRefSchema.safeParse(candidate);
    if (!parsed.success) return whole;
    const path = buildWebhookPathFromRef(parsed.data);
    if (path === null) {
      dedupedWarn(
        `webhook-ref-unresolved:${workflowId}`,
        { workflowId },
        'webhook ref non risolvibile: FLOWFORGE_SSO_SECRET assente — il link resta simbolico',
      );
      return whole;
    }
    return path;
  });
}
