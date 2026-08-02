/**
 * `action_odoo_create_lead` — config schema.
 *
 * Creates a crm.lead with the most common fields (name + contact info + tags
 * + owner). The Odoo `create()` API takes a values dict; this wrapper
 * marshals individual fields into that dict + handles tag many2many resolve.
 *
 * @module actions/odoo_create_lead/schema
 */

import { z } from 'zod';
import { odooAuthFields, odooHttpFields, csvList } from '../../lib/odoo/auth-schema-parts.js';

export const OdooCreateLeadConfigSchema = z
  .object({
    ...odooAuthFields,
    ...odooHttpFields,

    /** Opportunity title — required by Odoo. */
    name: z.string().min(1, 'lead name required').max(200),

    /** Customer email — Odoo auto-links to res.partner if matching. */
    emailFrom: z
      .string()
      .email()
      .max(254)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Customer phone number. */
    phone: z
      .string()
      .max(40)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Customer display name (when not creating partner via lookup). */
    partnerName: z
      .string()
      .max(200)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /** Description body — accepts plain text or HTML. */
    description: z
      .string()
      .max(20_000)
      .optional()
      .or(z.literal('').transform(() => undefined)),

    /** Already-known res.partner.id (skips the auto-linking probe). */
    partnerId: z.coerce.number().int().positive().optional(),

    /**
     * Comma-separated tag names. Each one is resolved server-side via
     * `crm.tag` `name_create` → idempotent (existing tags reused). The
     * many2many command `(6,0,[ids])` replaces the lead's tags with the
     * resolved set.
     */
    tagNames: csvList.optional(),

    /** Assign to user id (sales rep). */
    userId: z.coerce.number().int().positive().optional(),
    /** Assign to sales team id. */
    teamId: z.coerce.number().int().positive().optional(),

    /** Expected revenue (Decimal in cents/cur unit of the company). */
    expectedRevenue: z.coerce.number().min(0).max(1e9).optional(),
    /** Probability percent (0-100). */
    probability: z.coerce.number().min(0).max(100).optional(),

    /** Override the model — useful when Odoo install renamed crm.lead. */
    model: z
      .string()
      .regex(/^[a-z][a-z0-9_.]*$/i)
      .max(120)
      .default('crm.lead'),
  })
  .passthrough();

export type OdooCreateLeadConfig = z.infer<typeof OdooCreateLeadConfigSchema>;
