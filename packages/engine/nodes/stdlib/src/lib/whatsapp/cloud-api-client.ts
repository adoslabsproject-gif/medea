/**
 * WhatsApp Cloud API (Meta Graph) client.
 *
 * Endpoint: `POST https://graph.facebook.com/v{ver}/{phoneNumberId}/messages`
 *
 * Two send modes
 * ──────────────
 *   text     — `type: 'text'`, body in `text.body`
 *              REQUIRES an open "customer service window" (the recipient
 *              has messaged the business in the last 24h). Outside that
 *              window WhatsApp rejects with error 131047.
 *   template — `type: 'template'`, references a pre-approved template by
 *              `name` + `language`. Works ANY TIME (this is the only way
 *              to start a new conversation thread).
 *
 * Why this is a library (not just inline in the executor)
 * ────────────────────────────────────────────────────────
 * The Meta error responses are JSON with a deeply-nested `error.error_data
 * .messaging_product` shape; mapping them to typed errors uniformly is
 * worth its own module. We surface the canonical `error.code` so the
 * executor (or downstream nodes) can branch on it ("template not approved",
 * "rate limited", etc.) without re-parsing the body.
 *
 * @module lib/whatsapp/cloud-api-client
 */

const ERR_PREFIX = '[whatsapp]';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface WhatsAppAuth {
  /** Numeric Phone Number ID (NOT the phone number itself). */
  phoneNumberId: string;
  /** Meta permanent access token. */
  accessToken: string;
  /** API version, e.g. 'v18.0'. Default 'v20.0'. */
  apiVersion?: string;
  /** Base URL — overridable for testing. Default `https://graph.facebook.com`. */
  baseUrl?: string;
}

export interface WhatsAppHttpTransport {
  post(args: {
    url: string;
    body: string;
    headers: Readonly<Record<string, string>>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; text: string }>;
}

/** WhatsApp recipient — E.164 phone number (digits only, no `+`). */
export type WhatsAppRecipient = string;

export interface WhatsAppTextOptions {
  recipient: WhatsAppRecipient;
  body: string;
  /** Disable previews for URLs in the body. Default true (cheaper UX for billing). */
  previewUrl?: boolean;
}

/**
 * Template component — mirrors the Meta WhatsApp template message schema
 * minimally. Parameters are positional within each component.
 */
export interface WhatsAppTemplateComponent {
  type: 'body' | 'header' | 'button' | 'footer';
  parameters?: readonly (| { type: 'text'; text: string }
    | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
    | { type: 'date_time'; date_time: { fallback_value: string } }
    | { type: 'image'; image: { link: string } }
    | { type: 'document'; document: { link: string; filename?: string } }
    | { type: 'video'; video: { link: string } })[];
  /**
   * Button-specific extras (sub_type/index/parameters). Optional — only
   * used when `type` is `'button'`.
   */
  sub_type?: 'quick_reply' | 'url';
  index?: number;
}

export interface WhatsAppTemplateOptions {
  recipient: WhatsAppRecipient;
  /** Template name as approved in WhatsApp Business Manager. */
  templateName: string;
  /** Locale code, e.g. `it`, `en_US`. */
  languageCode: string;
  components?: readonly WhatsAppTemplateComponent[];
}

export interface WhatsAppResponse {
  /** Always 'whatsapp'. */
  messaging_product: 'whatsapp';
  /** Array with one element on success — the recipient phone (E.164 format). */
  contacts?: readonly { input: string; wa_id: string }[];
  /** Array with one element on success — the message id. */
  messages?: readonly { id: string; message_status?: string }[];
}

export class WhatsAppApiError extends Error {
  readonly code = 'WHATSAPP_API_ERROR' as const;
  constructor(
    /** Numeric error code from Meta (e.g. 131047 = re-engagement window closed). */
    readonly metaCode: number,
    /** Human-readable message from Meta. */
    readonly metaMessage: string,
    /** HTTP status, when known. */
    readonly status?: number,
  ) {
    super(`${ERR_PREFIX} Meta error ${metaCode}: ${metaMessage}`);
    this.name = 'WhatsAppApiError';
  }
}

export class WhatsAppTransportError extends Error {
  readonly code = 'WHATSAPP_TRANSPORT' as const;
  constructor(message: string, readonly status?: number) {
    super(`${ERR_PREFIX} ${message}`);
    this.name = 'WhatsAppTransportError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Recipient normalisation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a recipient phone into the Meta-required digits-only E.164
 * string. We strip the leading `+`, spaces, dashes, and parentheses.
 *
 * Throws when the result isn't between 8 and 15 digits (E.164 bounds).
 */
export function normaliseRecipient(input: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`${ERR_PREFIX} recipient must be a string`);
  }
  const stripped = input.replace(/[^0-9]/g, '');
  if (stripped.length < 8 || stripped.length > 15) {
    throw new TypeError(`${ERR_PREFIX} recipient "${input}" → "${stripped}" not a valid E.164 phone (8-15 digits)`);
  }
  return stripped;
}

// ────────────────────────────────────────────────────────────────────────────
// Send helpers
// ────────────────────────────────────────────────────────────────────────────

export async function sendText(
  auth: WhatsAppAuth,
  opts: WhatsAppTextOptions,
  transport: WhatsAppHttpTransport,
  fetchOpts: { timeoutMs: number; signal?: AbortSignal },
): Promise<WhatsAppResponse> {
  if (typeof opts.body !== 'string' || opts.body.length === 0) {
    throw new TypeError(`${ERR_PREFIX} body required`);
  }
  if (opts.body.length > 4096) {
    throw new TypeError(`${ERR_PREFIX} body exceeds 4096 char limit`);
  }
  const recipient = normaliseRecipient(opts.recipient);
  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'text',
    text: { body: opts.body, preview_url: opts.previewUrl ?? false },
  };
  return doSend(auth, payload, transport, fetchOpts);
}

export async function sendTemplate(
  auth: WhatsAppAuth,
  opts: WhatsAppTemplateOptions,
  transport: WhatsAppHttpTransport,
  fetchOpts: { timeoutMs: number; signal?: AbortSignal },
): Promise<WhatsAppResponse> {
  if (typeof opts.templateName !== 'string' || opts.templateName.length === 0) {
    throw new TypeError(`${ERR_PREFIX} templateName required`);
  }
  if (typeof opts.languageCode !== 'string' || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(opts.languageCode)) {
    throw new TypeError(`${ERR_PREFIX} languageCode must be e.g. "it" or "en_US"`);
  }
  const recipient = normaliseRecipient(opts.recipient);
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: opts.templateName,
      language: { code: opts.languageCode },
      components: opts.components ?? [],
    },
  };
  return doSend(auth, payload, transport, fetchOpts);
}

// ────────────────────────────────────────────────────────────────────────────
// Internal — HTTP POST + error mapping
// ────────────────────────────────────────────────────────────────────────────

async function doSend(
  auth: WhatsAppAuth,
  payload: unknown,
  transport: WhatsAppHttpTransport,
  fetchOpts: { timeoutMs: number; signal?: AbortSignal },
): Promise<WhatsAppResponse> {
  if (!/^[0-9]+$/.test(auth.phoneNumberId)) {
    throw new TypeError(`${ERR_PREFIX} phoneNumberId must be digits-only`);
  }
  if (typeof auth.accessToken !== 'string' || auth.accessToken.length < 16) {
    throw new TypeError(`${ERR_PREFIX} accessToken too short — likely missing or wrong`);
  }
  const apiVersion = auth.apiVersion ?? 'v20.0';
  const baseUrl = (auth.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
  const url = `${baseUrl}/${apiVersion}/${auth.phoneNumberId}/messages`;

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
  };

  const res = await transport.post({
    url,
    body,
    headers,
    timeoutMs: fetchOpts.timeoutMs,
    ...(fetchOpts.signal ? { signal: fetchOpts.signal } : {}),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new WhatsAppTransportError(
      `non-JSON response from Meta (status=${res.status}): ${res.text.slice(0, 200)}`,
      res.status,
    );
  }

  if (res.status >= 200 && res.status < 300) {
    return parsed as WhatsAppResponse;
  }

  // Error mapping — Meta wraps errors as `{ error: { code, message, ... } }`.
  const errObj = (parsed as { error?: { code?: number; message?: string } }).error;
  if (errObj && typeof errObj === 'object') {
    throw new WhatsAppApiError(
      typeof errObj.code === 'number' ? errObj.code : 0,
      typeof errObj.message === 'string' ? errObj.message : 'unknown',
      res.status,
    );
  }
  throw new WhatsAppTransportError(`HTTP ${res.status}: ${res.text.slice(0, 200)}`, res.status);
}
