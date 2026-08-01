import { SignJWT, jwtVerify, generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, importSPKI } from 'jose';
import { z } from 'zod';

const LICENSE_ALG = 'EdDSA';

export const LicenseTierSchema = z.enum(['free', 'starter', 'business', 'enterprise']);
export type LicenseTier = z.infer<typeof LicenseTierSchema>;

export const LicensePayloadSchema = z.object({
  licenseId: z.string().min(1),
  tier: LicenseTierSchema,
  seats: z.number().int().positive(),
  customer: z.object({
    name: z.string(),
    email: z.string().email(),
    vatId: z.string().optional(),
  }),
  features: z.array(z.string()),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

export interface LicenseKeyMaterial {
  privateKeyPem: string;
  publicKeyPem: string;
}

export async function generateLicenseKeyPair(): Promise<LicenseKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair(LICENSE_ALG, { extractable: true });
  return {
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
  };
}

/**
 * Issue a signed license token. Called by FlowForge's central licensing
 * service when a customer purchases. The token is delivered to the customer
 * and pasted into their installation's License section.
 */
export async function issueLicense(payload: LicensePayload, privateKeyPem: string): Promise<string> {
  const validated = LicensePayloadSchema.parse(payload);
  const privateKey = await importPKCS8(privateKeyPem, LICENSE_ALG);
  return new SignJWT({ ...validated })
    .setProtectedHeader({ alg: LICENSE_ALG })
    .setIssuer('flowforge-licensing')
    .setSubject(validated.licenseId)
    .setIssuedAt()
    .sign(privateKey);
}

export interface LicenseValidationResult {
  valid: boolean;
  payload?: LicensePayload;
  reason?: string;
}

/**
 * Verify a license token offline. The public key is bundled in the FlowForge
 * runtime binary (and rotated via signed updates). No network call needed —
 * customer can run air-gapped.
 */
export async function validateLicense(token: string, publicKeyPem: string): Promise<LicenseValidationResult> {
  try {
    const publicKey = await importSPKI(publicKeyPem, LICENSE_ALG);
    // N15 audit (2026-05-29): algorithms pin esplicito. jose con KeyLike
    // EdDSA accetta solo EdDSA, ma OWASP JWT 2023 raccomanda pin sempre
    // (defense-in-depth contro algorithm-confusion attack se in futuro
    // qualcuno cambiasse il key import a Uint8Array per HS256 fallback).
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: 'flowforge-licensing',
      algorithms: [LICENSE_ALG],
    });
    const parsed = LicensePayloadSchema.safeParse(payload);
    if (!parsed.success) return { valid: false, reason: `Schema invalid: ${parsed.error.message}` };
    if (parsed.data.expiresAt && new Date(parsed.data.expiresAt) < new Date()) {
      return { valid: false, payload: parsed.data, reason: 'License expired' };
    }
    return { valid: true, payload: parsed.data };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
