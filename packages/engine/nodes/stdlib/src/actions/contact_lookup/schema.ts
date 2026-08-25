/**
 * `action_contact_lookup` — Zod config schema.
 *
 * @module actions/contact_lookup/schema
 */

import { z } from 'zod';

const trimmed = z.string().trim();

/** Le spunte arrivano come stringhe: `"false"` deve valere falso davvero. */
const booleanish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (v === '' || v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  }
  if (typeof v === 'number') return v !== 0;
  return v;
}, z.boolean());

const intero = (min: number, max: number) =>
  z.preprocess((v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    if (typeof v === 'string') {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : v;
    }
    return v;
  }, z.number().int().min(min).max(max));

export const ContactLookupConfigSchema = z
  .object({
    email: trimmed.optional(),
    query: trimmed.optional(),
    onlyClients: booleanish.default(false),
    onlySuppliers: booleanish.default(false),
    requireFound: booleanish.default(false),
    limit: intero(1, 500).default(10),
  })
  .superRefine((c, ctx) => {
    // Senza né indirizzo né ricerca il nodo restituirebbe la rubrica intera,
    // che non è mai quello che si voleva: è una configurazione lasciata a metà.
    if (!c.email && !c.query) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Indica un indirizzo da cercare oppure una ricerca libera.',
        path: ['email'],
      });
    }
    // Cliente E fornitore insieme non seleziona niente: sono due colonne
    // distinte, e pretenderle entrambe vere è quasi sempre un errore di lettura
    // dei due interruttori.
    if (c.onlyClients && c.onlySuppliers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '«Solo clienti» e «solo fornitori» insieme lasciano fuori quasi tutti: tieni acceso uno solo.',
        path: ['onlySuppliers'],
      });
    }
  });

export type ContactLookupConfig = z.infer<typeof ContactLookupConfigSchema>;
