/**
 * `action_odoo_update_activity` — config schema.
 *
 * Logs a mail.activity record onto an existing Odoo record. Two modes:
 *   • activityTypeId numeric → use the configured type directly
 *   • activityTypeName string → resolve via search_read on mail.activity.type
 *
 * @module actions/odoo_update_activity/schema
 */

import { z } from 'zod';
import { odooAuthFields, odooHttpFields } from '../../lib/odoo/auth-schema-parts.js';

export const OdooUpdateActivityConfigSchema = z.object({
  ...odooAuthFields,
  ...odooHttpFields,

  /** Target model (e.g. `res.partner`, `crm.lead`, `sale.order`). */
  resModel: z.string()
    .min(1).max(120)
    .regex(/^[a-z][a-z0-9_.]*$/i, 'invalid model'),
  /** Target record id. */
  resId: z.coerce.number().int().positive(),

  /** Numeric activity type id (mail.activity.type). */
  activityTypeId: z.coerce.number().int().positive().optional(),
  /** Free-text activity type name — resolved server-side if id missing. */
  activityTypeName: z.string().max(120).optional()
    .or(z.literal('').transform(() => undefined)),

  /** Short summary shown on the activity card. */
  summary: z.string().min(1, 'summary required').max(200),
  /** HTML body (rich note). */
  noteHtml: z.string().max(20_000).optional()
    .or(z.literal('').transform(() => undefined)),
  /** Deadline (YYYY-MM-DD). When empty, today. */
  dateDeadline: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date format YYYY-MM-DD')
    .optional()
    .or(z.literal('').transform(() => undefined)),

  /** Assignee user id. When empty, current authenticated user. */
  userId: z.coerce.number().int().positive().optional(),

}).passthrough().superRefine((cfg, ctx) => {
  if (!cfg.activityTypeId && !cfg.activityTypeName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activityTypeId'],
      message: 'either activityTypeId or activityTypeName is required',
    });
  }
});

export type OdooUpdateActivityConfig = z.infer<typeof OdooUpdateActivityConfigSchema>;
