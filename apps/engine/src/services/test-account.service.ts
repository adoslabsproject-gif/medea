/**
 * TestAccountService — auto-provisions a fixed test account at boot when
 * MEDEA_E2E_AUTO_PROVISION=1 is set. Used by the Playwright smoke
 * suite so deploys are gated by a real end-to-end test against a real
 * editor instance, not just by `tsc` compilation success.
 *
 * Account:
 *   email:     MEDEA_E2E_EMAIL    (default: e2e@flowforge.local)
 *   password:  MEDEA_E2E_PASSWORD (default: a 32-char random secret
 *              generated at first boot and written to a file the operator
 *              can read with `cat /var/lib/flowforge/.e2e-password`)
 *   role:      'owner' on its own tenant 'e2e' — isolated from production
 *              data so it cannot leak or interfere.
 *
 * Idempotent: subsequent boots reuse the same account; password is left
 * untouched if it already exists.
 *
 * Disable: do NOT set MEDEA_E2E_AUTO_PROVISION (or set =0). The smoke
 * tests will skip when the env vars are absent.
 */

import crypto from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { hashPassword } from '@medea/engine-auth-local';
import { getDatabase } from '@/storage/db.js';
import { logger } from '@/lib/logger.js';

const DEFAULT_EMAIL = 'e2e@flowforge.local';
// Same tenant as production data so the frontend's "no tenant header" login
// flow works without modification. The account is role=editor — sufficient
// to create workflows + nodes for smoke tests, but cannot manage users.
const DEFAULT_TENANT = 'default';
const PASSWORD_FILE = process.env.MEDEA_E2E_PASSWORD_FILE ?? '/var/lib/flowforge/.e2e-password';

export async function provisionTestAccount(): Promise<void> {
  if (process.env.MEDEA_E2E_AUTO_PROVISION !== '1') return;
  const email = process.env.MEDEA_E2E_EMAIL ?? DEFAULT_EMAIL;
  const tenantId = process.env.MEDEA_E2E_TENANT ?? DEFAULT_TENANT;

  // Resolve / generate the password
  let password = process.env.MEDEA_E2E_PASSWORD;
  if (!password) {
    if (existsSync(PASSWORD_FILE)) {
      password = readFileSync(PASSWORD_FILE, 'utf8').trim();
    } else {
      password = crypto.randomBytes(24).toString('base64url');
      try {
        mkdirSync(dirname(PASSWORD_FILE), { recursive: true });
        writeFileSync(PASSWORD_FILE, password, { mode: 0o600 });
      } catch (err) {
        logger.warn(
          { err, PASSWORD_FILE },
          'Cannot persist e2e password file — set MEDEA_E2E_PASSWORD env',
        );
      }
    }
  }

  const { sqlite } = getDatabase();
  const existing = sqlite
    .prepare('SELECT id FROM users WHERE tenant_id = ? AND email = ?')
    .get(tenantId, email) as { id?: string } | undefined;

  if (existing?.id) {
    logger.info({ email, tenantId, userId: existing.id }, 'E2E test account already exists');
    return;
  }

  const id = nanoid();
  const now = new Date().toISOString();
  const hash = await hashPassword(password);
  sqlite
    .prepare(
      // is_system=1 hides this user from /users API and blocks DELETE.
      // Without it, owners who clean their user list see it reappear at
      // every deploy because the deploy script re-provisions the account
      // for the Playwright smoke gate.
      'INSERT INTO users (id, tenant_id, email, display_name, password_hash, role, enabled, created_at, updated_at, is_system) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)',
    )
    .run(id, tenantId, email, 'E2E Test Account', hash, 'editor', now, now);
  logger.info(
    { userId: id, tenantId, email, isSystem: true },
    'E2E test account provisioned (hidden from /users API)',
  );
}
