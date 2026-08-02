import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportPKCS8,
  exportSPKI,
  importPKCS8,
  importSPKI,
} from 'jose';
import { randomUUID } from 'node:crypto';
import type { Role, SessionTokenPayload } from './types.js';

const ALG = 'RS256';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export interface KeyMaterial {
  privateKeyPem: string;
  publicKeyPem: string;
}

export async function generateSessionKeyPair(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    modulusLength: 2048,
    extractable: true,
  });
  return {
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
  };
}

export interface IssueTokenInput {
  userId: string;
  tenantId: string;
  email: string;
  role: Role;
  privateKeyPem: string;
  ttlSeconds?: number;
}

export async function issueSessionToken(input: IssueTokenInput): Promise<string> {
  const privateKey = await importPKCS8(input.privateKeyPem, ALG);
  return (
    new SignJWT({
      tenantId: input.tenantId,
      role: input.role,
      email: input.email,
    })
      .setProtectedHeader({ alg: ALG })
      .setSubject(input.userId)
      .setIssuedAt()
      .setExpirationTime(`${(input.ttlSeconds ?? SESSION_TTL_SECONDS).toString()}s`)
      .setIssuer('flowforge')
      .setAudience('flowforge')
      // jti univoco → consente la revoca server-side (blocklist) del singolo token.
      .setJti(randomUUID())
      .sign(privateKey)
  );
}

export async function verifySessionToken(
  token: string,
  publicKeyPem: string,
): Promise<SessionTokenPayload | null> {
  try {
    const publicKey = await importSPKI(publicKeyPem, ALG);
    // N15 audit (2026-05-29): algorithms pin esplicito. jose con KeyLike
    // RSA accetta solo RS256/RS384/RS512/PS256/PS384/PS512, ma OWASP JWT
    // cheatsheet 2023 raccomanda pin sempre (defense-in-depth contro
    // algorithm-confusion attack se key import diventasse Uint8Array).
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: 'flowforge',
      audience: 'flowforge',
      algorithms: [ALG],
    });
    return payload as unknown as SessionTokenPayload;
  } catch {
    return null;
  }
}
