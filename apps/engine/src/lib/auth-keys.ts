import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateSessionKeyPair, type KeyMaterial } from '@medea/engine-auth-local';
import { loadConfig } from '@/config.js';
import { logger } from './logger.js';

let cached: KeyMaterial | null = null;

export async function getAuthKeys(): Promise<KeyMaterial> {
  if (cached) return cached;
  const config = loadConfig();
  const dir = config.MEDEA_DATA_DIR;
  const privPath = join(dir, 'session-private.pem');
  const pubPath = join(dir, 'session-public.pem');

  if (existsSync(privPath) && existsSync(pubPath)) {
    cached = {
      privateKeyPem: readFileSync(privPath, 'utf8'),
      publicKeyPem: readFileSync(pubPath, 'utf8'),
    };
    return cached;
  }

  logger.info('Generating new session key pair (first-run setup)');
  const generated = await generateSessionKeyPair();
  mkdirSync(dirname(privPath), { recursive: true });
  writeFileSync(privPath, generated.privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, generated.publicKeyPem);
  cached = generated;
  return cached;
}
