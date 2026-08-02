/**
 * `action_whatsapp_send` — Zod config schema.
 *
 * Two modes (`text` / `template`) controlled by the `mode` field, with
 * cross-field rules enforcing the right inputs per mode.
 *
 * @module actions/whatsapp_send/schema
 */

import { z } from 'zod';

const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
]);

const componentsArray = z
  .string()
  .optional()
  .default('')
  .transform((raw, ctx) => {
    if (!raw || raw.trim() === '') return undefined as unknown as unknown[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'components must be a JSON array' });
        return z.NEVER;
      }
      return parsed as unknown[];
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid JSON for components: ${err instanceof Error ? err.message : String(err)}`,
      });
      return z.NEVER;
    }
  });

export const WhatsAppSendConfigSchema = z
  .object({
    // ── Authentication
    phoneNumberId: z
      .string()
      .regex(
        /^[0-9]+$/,
        "phoneNumberId must be digits-only (NOT the phone number itself — that's the recipient)",
      )
      .min(8)
      .max(30),
    accessToken: z.string().min(16, 'accessToken too short — likely missing or wrong'),
    apiVersion: z
      .string()
      .regex(/^v[0-9]+\.[0-9]+$/, 'apiVersion must be e.g. "v20.0"')
      .default('v20.0'),

    // ── Recipient
    recipient: z.string().min(8, 'recipient required — E.164 phone (+39...)').max(40),

    // ── Mode
    mode: z.enum(['text', 'template']).default('text'),

    // ── Text mode
    body: z.string().max(4096).optional(),
    previewUrl: boolish.default(false),

    // ── Template mode
    templateName: z.string().min(1).max(120).optional(),
    languageCode: z
      .string()
      .regex(/^[a-z]{2}(?:_[A-Z]{2})?$/, 'languageCode must be e.g. "it" or "en_US"')
      .optional(),
    componentsJson: componentsArray.optional(),

    // ── HTTP knobs
    timeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    includePipelineLog: boolish.default(true),
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    const addRequired = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };
    if (cfg.mode === 'text') {
      if (!cfg.body || cfg.body.length === 0) addRequired(['body'], 'body required for mode=text');
    } else {
      if (!cfg.templateName)
        addRequired(['templateName'], 'templateName required for mode=template');
      if (!cfg.languageCode)
        addRequired(['languageCode'], 'languageCode required for mode=template');
    }
  });

export type WhatsAppSendConfig = z.infer<typeof WhatsAppSendConfigSchema>;
