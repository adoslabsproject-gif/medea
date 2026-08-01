import { z } from 'zod';

/**
 * Role hierarchy:
 *   superadmin  — cross-tenant, sees all tenants (you, the SaaS provider)
 *   owner       — tenant admin, manages users + all workflows
 *   editor      — can create/edit workflows
 *   operator    — can run workflows, can't edit
 *   viewer      — read-only (run history, status)
 */
export const RoleSchema = z.enum(['superadmin', 'owner', 'editor', 'operator', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string(),
  passwordHash: z.string(),
  role: RoleSchema,
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const SessionTokenPayloadSchema = z.object({
  sub: z.string().min(1),
  tenantId: z.string().min(1),
  role: RoleSchema,
  email: z.string().email(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  // jti: identificatore univoco del token, base della blocklist di revoca
  // server-side (logout / "revoca sessione"). Optional per retrocompat con i
  // token legacy emessi prima dell'introduzione (revocati via fallback sub:iat).
  jti: z.string().optional(),
});
export type SessionTokenPayload = z.infer<typeof SessionTokenPayloadSchema>;
