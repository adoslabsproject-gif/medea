/**
 * Config parser — Zod schema parse-once per NodeDef.
 *
 * Sostituisce il pattern legacy `safeString(config.url)` ripetuto-a-runtime
 * con un parse Zod che valida UNA VOLTA + ritorna un Result tipato.
 *
 * Pattern v2:
 *
 *   // definition.ts
 *   export const HttpConfigSchema = z.object({
 *     method: z.enum(['GET','POST',...]).default('GET'),
 *     url: z.string().url(),
 *     timeoutMs: z.coerce.number().int().positive().default(30_000),
 *   });
 *   export type HttpConfig = z.infer<typeof HttpConfigSchema>;
 *
 *   // executor.ts
 *   import { parseConfig } from '../core/config-parser.js';
 *   const cfg = parseConfig(HttpConfigSchema, rawConfig);
 *   if (!cfg.ok) return cfg;
 *   const { url, method, timeoutMs } = cfg.value;
 *
 * Vantaggi vs legacy:
 *   • Validation errors arrivano come ValidationError typed (con field path)
 *   • Default values applicati implicitly da Zod (no need defaultValue scattered)
 *   • Type inference: il chiamante riceve la versione tipizzata, non
 *     `Record<string, unknown>`. Refactor-safe.
 *   • z.coerce.number sostituisce safeNumber — gestisce strings ("30000" → 30000)
 *
 * NON sostituisce `NodeDef.configFields` (rimangono per UI rendering / palette);
 * il parser e\` un layer aggiuntivo per la validation runtime opt-in per nodo.
 */

import { z, type ZodTypeAny, type ZodIssue } from 'zod';
import { ok, err, type Result } from './result.js';
import { ValidationError } from './node-error.js';

/**
 * Parse a raw config map against a Zod schema. Returns Result with the
 * typed config on success, or ValidationError listing field paths + reasons
 * on failure.
 *
 *   const cfg = parseConfig(HttpConfigSchema, node.config);
 *   if (!cfg.ok) return cfg;  // propagate err
 *   doSomething(cfg.value.url);  // typed!
 */
export function parseConfig<S extends ZodTypeAny>(
  schema: S,
  raw: unknown,
): Result<z.infer<S>, ValidationError> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const message = formatZodIssues(parsed.error.issues);
  return err(new ValidationError(message, { issues: parsed.error.issues }));
}

/**
 * Throwing variant — usata SOLO al boot/test (es. registry sanity check
 * che ogni NodeDef abbia un config schema coerente). NON usare a runtime
 * dentro executor: usa `parseConfig` che ritorna Result.
 */
export function parseConfigOrThrow<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const r = parseConfig(schema, raw);
  if (!r.ok) throw r.error;
  return r.value;
}

/**
 * Format Zod issues into a single human-readable message ottimizzato per UI.
 *
 *   url: Required, body[0].id: must be number
 */
function formatZodIssues(issues: readonly ZodIssue[]): string {
  if (issues.length === 0) return 'Config invalido';
  const parts: string[] = [];
  for (const issue of issues) {
    const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    parts.push(`${path}: ${issue.message}`);
  }
  return parts.join(' · ');
}

/**
 * Helper per nodi che richiedono N campi obbligatori MA ammettono N campi
 * opzionali extra (pass-through). Wrap di z.object con .passthrough() esplicito.
 *
 *   const Schema = defineConfigSchema({ url: z.string().url() });
 *   // valida `url` MA non blocca campi extra (compat con configFields legacy).
 */
export function defineConfigSchema<T extends z.ZodRawShape>(
  shape: T,
): z.ZodObject<T, 'passthrough'> {
  return z.object(shape).passthrough();
}

/**
 * Comuni utility schema riusabili da molti nodi — evita ridefinizioni.
 * Convenzione: tutti i numeri accettano stringhe (z.coerce) per compat
 * con i config che arrivano da JSON / form (sempre stringificati).
 */
export const commonSchemas = {
  /** Numero positivo (intero), default opzionale. */
  positiveInt: (defaultValue?: number) =>
    defaultValue !== undefined
      ? z.coerce.number().int().positive().default(defaultValue)
      : z.coerce.number().int().positive(),

  /** Timeout ms — positivo, cap a 10 min per safety. */
  timeoutMs: (defaultValue = 30_000) =>
    z.coerce.number().int().positive().max(600_000).default(defaultValue),

  /** URL valida (http/https), no scheme custom. */
  httpUrl: () =>
    z
      .string()
      .url()
      .refine((u) => /^https?:\/\//iu.test(u), {
        message: 'URL deve iniziare con http:// o https://',
      }),

  /** Booleano permissivo (accetta 'true'/'false' string). */
  boolish: (defaultValue = false) =>
    z
      .union([
        z.boolean(),
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
      ])
      .default(defaultValue),

  /** Key-value JSON string → Record<string,string>. Vuoto o invalido → {}. */
  kvJsonString: () =>
    z
      .string()
      .optional()
      .default('')
      .transform((raw): Record<string, string> => {
        if (!raw || raw.trim() === '') return {};
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            out[k] = String(v);
          }
          return out;
        } catch {
          return {};
        }
      }),
};
