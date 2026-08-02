/**
 * Zod fragments shared across all Odoo wrapper nodes (lookup_partner /
 * create_lead / update_activity / future) so the auth UX stays consistent
 * with `action_odoo_rpc` and the validation rules don't drift.
 *
 * @module lib/odoo/auth-schema-parts
 */

import { z } from 'zod';

export const httpsUrl = z
  .string()
  .min(1, 'baseUrl required')
  .max(500)
  .refine((s) => /^https?:\/\//i.test(s), { message: 'baseUrl must be http(s)://' });

export const boolish = z.union([
  z.boolean(),
  z.literal('true').transform(() => true),
  z.literal('false').transform(() => false),
  z.literal('1').transform(() => true),
  z.literal('0').transform(() => false),
  z.literal('on').transform(() => true),
  z.literal('off').transform(() => false),
]);

/** Standard auth quartet for every Odoo wrapper. */
export const odooAuthFields = {
  baseUrl: httpsUrl,
  database: z.string().min(1, 'database required').max(120),
  login: z.string().min(1, 'login required').max(200),
  password: z.string().min(1, 'password / api key required').max(500),
} as const;

/** Standard HTTP knobs. */
export const odooHttpFields = {
  timeoutMs: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  followRedirects: boolish.default(true),
} as const;

/** Reusable JSON list of strings (Odoo tag names / emails / etc). */
export const csvList = z
  .string()
  .max(1_000)
  .transform((s) =>
    s
      .split(/[,;\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
