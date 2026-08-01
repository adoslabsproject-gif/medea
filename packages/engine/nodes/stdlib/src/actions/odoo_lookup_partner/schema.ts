/**
 * `action_odoo_lookup_partner` — config schema.
 *
 * Lookup precedence (when multiple identifiers are supplied):
 *   email > vat > phone > name.
 *
 * The executor stops at the first hit so the cheaper search runs first.
 *
 * @module actions/odoo_lookup_partner/schema
 */

import { z } from 'zod';
import { odooAuthFields, odooHttpFields, boolish } from '../../lib/odoo/auth-schema-parts.js';

export const OdooLookupPartnerConfigSchema = z.object({
  ...odooAuthFields,
  ...odooHttpFields,

  /** Email to match (case-insensitive). */
  email: z.string().max(254).optional()
    .or(z.literal('').transform(() => undefined)),
  /** Italian P.IVA / EU VAT to match (digits only, IT prefix tolerated). */
  vat: z.string().max(20).optional()
    .or(z.literal('').transform(() => undefined)),
  /** Phone number to match (anything matching `\d{6,15}` after normalisation). */
  phone: z.string().max(40).optional()
    .or(z.literal('').transform(() => undefined)),
  /** Free-text name (used as last-resort substring match). */
  name: z.string().max(200).optional()
    .or(z.literal('').transform(() => undefined)),

  /** Restrict the search to the given company_id (Odoo multi-company). */
  companyId: z.coerce.number().int().positive().optional(),

  /**
   * If true and the lookup misses, create a new res.partner with the
   * provided fields. The created partner is in `output` like a hit, with
   * `created: true` so downstream nodes can distinguish.
   */
  createIfMissing: boolish.default(false),

  /** Fields returned for the matched / created partner. */
  returnFields: z.string().max(500)
    .default('id,name,email,phone,vat,company_id,user_id'),
}).passthrough().superRefine((cfg, ctx) => {
  // At least ONE identifier must be present otherwise the search is
  // unbounded → potentially returns a random partner.
  if (!cfg.email && !cfg.vat && !cfg.phone && !cfg.name) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['email'],
      message: 'at least one of email / vat / phone / name is required',
    });
  }
  if (cfg.createIfMissing && !cfg.email && !cfg.name) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['createIfMissing'],
      message: 'createIfMissing requires at least email OR name to populate the new partner',
    });
  }
});

export type OdooLookupPartnerConfig = z.infer<typeof OdooLookupPartnerConfigSchema>;
