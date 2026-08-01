/**
 * HTTP node — Zod config schema (parse-once).
 *
 * Si oppone al pattern legacy `safeString(config.url)` ripetuto-a-runtime:
 * lo schema valida UNA VOLTA all'ingresso dell'executor e ritorna un oggetto
 * fortemente tipato. I default sono dichiarati dentro Zod (no piu\` scattered
 * `safeNumber(c, 30_000)`).
 *
 * Passthrough() ammette campi extra (compat con configFields legacy non listati).
 */

import { z } from 'zod';

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET');

export const HttpAuthModeSchema = z.enum(['none', 'basic', 'bearer', 'apikey-header', 'custom', 'oauth2']).default('none');

/** OAuth2 client_credentials: dove mandare le credenziali del client sul token endpoint.
 *  'header' = HTTP Basic (RFC 6749 §2.3.1, raccomandato); 'body' = client_id/secret nel form. */
export const OAuth2AuthStyleSchema = z.enum(['header', 'body']).default('header');

export const HttpBodyTypeSchema = z.enum(['none', 'json', 'form-urlencoded', 'multipart', 'raw-text', 'raw-binary-base64', 'binary']).default('json');

export const HttpResponseFormatSchema = z.enum(['auto', 'json', 'text', 'binary']).default('auto');

export const HttpPaginationModeSchema = z.enum(['none', 'page-number', 'offset-limit', 'cursor', 'link-header']).default('none');

/**
 * Boolean coercer compatibile coi valori UI legacy (true | 'true' | 'on' | '1').
 */
const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
]);

/**
 * Campi key-value (Headers / Query / Form): il kv-editor serializza in STRINGA JSON
 * (parseKvJson accetta solo string); il record è ammesso come fallback difensivo per
 * non far throware il parse se l'editor invia già un oggetto. Niente più `z.unknown()`.
 */
const KvJson = z.union([z.string(), z.record(z.string(), z.unknown())]).nullish();

export const HttpConfigSchema = z.object({
  // ── Core
  method: HttpMethodSchema,
  url: z.string().min(1, 'url is required'),

  // ── Auth (tipizzati: i secret sono stringhe/template, non `unknown`)
  authMode: HttpAuthModeSchema,
  basicUser: z.string().nullish(),
  basicPass: z.string().nullish(),
  bearerToken: z.string().nullish(),
  apiKeyHeaderName: z.string().nullish(),
  apiKeyValue: z.string().nullish(),
  customAuthHeaderName: z.string().nullish(),
  customAuthHeaderValue: z.string().nullish(),

  // ── OAuth2 client_credentials (grant machine-to-machine): il nodo ottiene un
  //    access-token dal token endpoint e lo inietta come Bearer. Token cachato
  //    fino a (expires_in - margine) per non richiederlo a ogni request.
  oauth2TokenUrl: z.string().nullish(),
  oauth2ClientId: z.string().nullish(),
  oauth2ClientSecret: z.string().nullish(),
  oauth2Scope: z.string().nullish(),
  // NON .optional(): OAuth2AuthStyleSchema porta già .default('header') → undefined
  // diventa 'header' (un .optional() esterno annullerebbe il default).
  oauth2AuthStyle: OAuth2AuthStyleSchema,

  // ── Query / Headers
  queryParamsJson: KvJson,
  headersJson: KvJson,

  // ── Body (testo JSON/raw/base64 oppure oggetto/array strutturato)
  bodyType: HttpBodyTypeSchema,
  body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish(),
  formFields: KvJson,
  rawBinaryContentType: z.string().nullish(),

  // ── Pagination
  paginationMode: HttpPaginationModeSchema,
  paginationMaxPages: z.coerce.number().int().positive().max(1000).default(10),
  paginationPageSize: z.coerce.number().int().positive().max(10_000).default(50),
  paginationItemsField: z.string().optional().default(''),
  paginationPageParam: z.string().optional().default('page'),
  paginationStartPage: z.coerce.number().int().nonnegative().default(1),
  paginationLimitParam: z.string().optional().default('limit'),
  paginationOffsetParam: z.string().optional().default('offset'),
  paginationStartOffset: z.coerce.number().int().nonnegative().default(0),
  paginationCursorParam: z.string().optional().default('cursor'),
  paginationCursorField: z.string().optional().default('next_cursor'),

  // ── Retry
  // retryStrategy: chi possiede il retry (un solo livello, mai annidato). 'auto' →
  // il nodo HTTP (self-managed) ritenta internamente; 'workflow' → lascia al motore;
  // 'none' → niente. Risolto via resolveRetryOwner (core-schema).
  retryStrategy: z.enum(['auto', 'node', 'workflow', 'none']).default('auto'),
  retryCount: z.coerce.number().int().min(0).max(10).default(0),
  retryInitialDelayMs: z.coerce.number().int().min(0).max(60_000).default(500),
  retryBackoffFactor: z.coerce.number().min(1).max(10).default(2),
  // Default ALLINEATO al defaultValue UI (era '' → divergenza: un workflow Liara che lo
  // ometteva NON ritentava i 5xx mentre l'utente UI sì). Conta solo con retryCount>0.
  retryOnStatus: z.string().optional().default('429,500,502,503,504'),

  // ── Response handling
  responseFormat: HttpResponseFormatSchema,
  followRedirects: boolish.optional().default(true),
  allowSelfSigned: boolish.optional().default(false),
  statusCodeOnly: boolish.optional().default(false),
  timeoutMs: z.coerce.number().int().positive().max(600_000).default(30_000),
  // Cap dimensione risposta (MB). Default 50 (era promesso ma MAI enforced → OOM/DoS
  // su risposte enormi, fix 2026-06-17). Override per-call fino a 500 MB. Enforced
  // sia via content-length sia in streaming (il content-length può mancare/mentire).
  maxResponseMb: z.coerce.number().int().positive().max(500).default(50),
  // Default RUNTIME false: il defaultValue 'true' nei configFields e\` solo
  // per la UI editor. Behavior preservato da v2 dove `asBool(undefined) = false`
  // → non throware se l'utente non lo richiede esplicitamente. Vedi http.test.ts:439.
  throwOnError: boolish.optional().default(false),
}).passthrough().superRefine((c, ctx) => {
  // Cross-field authMode↔credenziale: selezionare un mode SENZA la sua credenziale è
  // un errore di config (es. authMode=bearer ma token vuoto → la richiesta partirebbe
  // senza Authorization). Fail-fast con messaggio mirato. (authMode='none' = nessun
  // vincolo: l'auth può essere gestita manualmente via Headers.)
  const empty = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (c.authMode === 'basic' && empty(c.basicUser) && empty(c.basicPass)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['basicUser'], message: 'authMode=basic richiede username e/o password' });
  }
  if (c.authMode === 'bearer' && empty(c.bearerToken)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bearerToken'], message: 'authMode=bearer richiede un token' });
  }
  if (c.authMode === 'apikey-header' && empty(c.apiKeyValue)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeyValue'], message: 'authMode=apikey-header richiede il valore della API key' });
  }
  if (c.authMode === 'custom' && empty(c.customAuthHeaderValue)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customAuthHeaderValue'], message: 'authMode=custom richiede il valore dell\'header' });
  }
  if (c.authMode === 'oauth2') {
    if (empty(c.oauth2TokenUrl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oauth2TokenUrl'], message: 'authMode=oauth2 richiede il token endpoint URL' });
    }
    if (empty(c.oauth2ClientId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oauth2ClientId'], message: 'authMode=oauth2 richiede il client_id' });
    }
    if (empty(c.oauth2ClientSecret)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oauth2ClientSecret'], message: 'authMode=oauth2 richiede il client_secret' });
    }
  }
});

export type HttpConfig = z.infer<typeof HttpConfigSchema>;
