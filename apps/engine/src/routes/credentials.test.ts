/**
 * Test credentials route — /reveal role gate regression 2026-05-29.
 *
 * Fix: GET /:id/reveal ora richiede requireRole('owner', 'superadmin').
 * Pre-fix: chiunque con session valida (anche viewer/editor) poteva
 * esfiltrare API key plaintext.
 *
 * Verifichiamo che il middleware requireRole sia applicato alla route.
 * Test grossolano via source inspection (il binding effettivo lo testano
 * gli integration test E2E del runtime).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const credentialsSource = readFileSync(join(__dirname, 'credentials.ts'), 'utf-8');

describe('credentials route — /reveal role gate', () => {
  it('importa requireRole dal middleware/auth', () => {
    expect(credentialsSource).toMatch(
      /import\s+\{[^}]*requireRole[^}]*\}\s+from\s+['"]@\/middleware\/auth\.js['"]/,
    );
  });

  it('GET /:id/reveal applica requireRole owner+superadmin', () => {
    // Pattern: app.get('/:id/reveal', requireRole('owner', 'superadmin'), ...)
    expect(credentialsSource).toMatch(
      /app\.get\(\s*['"]\/:id\/reveal['"]\s*,\s*requireRole\(['"]owner['"]\s*,\s*['"]superadmin['"]\)/,
    );
  });

  it("NON c'è un /reveal senza requireRole gate (anti-regression)", () => {
    // Cerca tutti i `/:id/reveal` references e verifica che ognuno abbia requireRole vicino
    const revealOccurrences = credentialsSource.match(/['"]\/:id\/reveal['"]/g) ?? [];
    expect(revealOccurrences.length).toBeGreaterThan(0);
    // Find each occurrence context (50 char before/after)
    let idx = 0;
    while ((idx = credentialsSource.indexOf("'/:id/reveal'", idx)) !== -1) {
      const ctx = credentialsSource.slice(Math.max(0, idx - 200), idx + 100);
      expect(ctx).toMatch(/requireRole/);
      idx += 1;
    }
  });

  it('GET / (list) NON ha requireRole (visibile a tutti)', () => {
    // Pattern: app.get('/', (c) => { ... }) — no middleware
    expect(credentialsSource).toMatch(/app\.get\(\s*['"]\/['"]\s*,\s*\(c\)/);
  });
});

// ════════════════════════════════════════════════════════════════════
// Bug-bounty FULL-REQUEST-PATH (audit coverage 2026-06-12: route a ZERO
// righe eseguite, CredentialsService al 19% — il suo unit test mocka
// vault+master-password+sqlite; i guard sopra sono source-inspection).
//
// Qui NIENTE mock: CredentialsService REALE con envelope encryption
// AES-256-GCM vera (master password dev-sentinel in test, vault salt su
// MEDEA_DATA_DIR) + tabella user_credentials reale. È l'API dei SEGRETI
// dei tenant: le invarianti pinnate sono quelle che un pentester prova
// per prime.
// ════════════════════════════════════════════════════════════════════
import { beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { runMigrations } from '@/storage/migrate.js';
import { getDatabase } from '@/storage/db.js';
import { createCredentialsRoutes } from './credentials.js';
import type { AuthContext } from '@/middleware/auth.js';

const T_A = `test-cred-${Date.now().toString(36)}-a`;
const T_B = `test-cred-${Date.now().toString(36)}-b`;
const SECRET = 'sk-live-SEGRETISSIMO-1234567890abcdef';

let authCtx: AuthContext | null = null;
const asUser = (tenantId: string, role: AuthContext['role']): void => {
  authCtx = { userId: `u-${role}`, tenantId, email: `${role}@test.it`, role };
};

let app: Hono;
interface SqliteLike {
  prepare: (s: string) => {
    get: (...p: unknown[]) => unknown;
    all: (...p: unknown[]) => unknown[];
    run: (...p: unknown[]) => unknown;
  };
}
const db = (): SqliteLike => getDatabase().sqlite as unknown as SqliteLike;

beforeAll(() => {
  runMigrations();
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authCtx);
    await next();
  });
  app.route('/api/v1/credentials', createCredentialsRoutes());
});

afterAll(() => {
  db().prepare("DELETE FROM user_credentials WHERE tenant_id LIKE 'test-cred-%'").run();
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/v1/credentials${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );

describe('credentials — superficie segreti (full request path, crypto REALE)', () => {
  let credId = '';

  it('senza auth → MAI 200', async () => {
    authCtx = null;
    expect((await req('GET', '')).status).not.toBe(200);
    expect((await req('POST', '', { name: 'x', provider: 'p', plaintext: 's' })).status).not.toBe(
      200,
    );
  });

  it('POST create → 201 e il plaintext NON è nella response', async () => {
    asUser(T_A, 'owner');
    const res = await req('POST', '', {
      name: 'OpenAI key',
      provider: 'openai',
      plaintext: SECRET,
      metadata: { env: 'prod' },
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    credId = (JSON.parse(text) as { credential: { id: string } }).credential.id;
    expect(credId).toBeTruthy();
  });

  it('AT-REST: la riga user_credentials NON contiene il plaintext in NESSUNA colonna (cifratura vera, non base64 di facciata)', () => {
    const row = db().prepare('SELECT * FROM user_credentials WHERE id = ?').get(credId) as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
    for (const [col, val] of Object.entries(row)) {
      const s = Buffer.isBuffer(val)
        ? (val as Buffer).toString('latin1') + (val as Buffer).toString('base64')
        : String(val);
      expect(s.includes(SECRET), `plaintext trovato nella colonna "${col}"`).toBe(false);
    }
  });

  it('GET list → mai plaintext/ciphertext nel payload (solo metadati)', async () => {
    asUser(T_A, 'viewer');
    const res = await req('GET', '');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/ciphertext|dek_/);
    const data = JSON.parse(text) as { credentials: { id: string }[] };
    expect(data.credentials.some((cr) => cr.id === credId)).toBe(true);
  });

  it('reveal: viewer/editor/operator → 403 (un editor non esfiltra API key)', async () => {
    for (const role of ['viewer', 'editor', 'operator'] as const) {
      asUser(T_A, role);
      expect((await req('GET', `/${credId}/reveal`)).status, role).toBe(403);
    }
  });

  it('reveal: ruolo IGNOTO → 403 (fail-closed: non in allowedRoles)', async () => {
    authCtx = { userId: 'u', tenantId: T_A, email: 'x@t.it', role: 'admin' as AuthContext['role'] };
    expect((await req('GET', `/${credId}/reveal`)).status).toBe(403);
  });

  it('reveal owner → ROUND-TRIP ESATTO del plaintext (envelope encryption vera, non echo)', async () => {
    asUser(T_A, 'owner');
    const res = await req('GET', `/${credId}/reveal`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plaintext: string }).plaintext).toBe(SECRET);
  });

  it('reveal superadmin → 200 (bypass by-design del ruolo piattaforma)', async () => {
    asUser(T_A, 'superadmin');
    expect((await req('GET', `/${credId}/reveal`)).status).toBe(200);
  });

  it('ISOLAMENTO: owner del tenant B → reveal 404 e delete 404 sulla credenziale di A, riga INTATTA', async () => {
    asUser(T_B, 'owner');
    expect((await req('GET', `/${credId}/reveal`)).status).toBe(404);
    expect((await req('DELETE', `/${credId}`)).status).toBe(404);
    expect(db().prepare('SELECT id FROM user_credentials WHERE id = ?').get(credId)).toBeDefined();
  });

  it('validazione: plaintext vuoto → 400, name oltre 200 → 400', async () => {
    asUser(T_A, 'owner');
    expect((await req('POST', '', { name: 'x', provider: 'p', plaintext: '' })).status).toBe(400);
    expect(
      (await req('POST', '', { name: 'x'.repeat(201), provider: 'p', plaintext: 's' })).status,
    ).toBe(400);
  });

  it('DELETE owner → 204, sparita dalla list, re-delete → 404', async () => {
    asUser(T_A, 'owner');
    expect((await req('DELETE', `/${credId}`)).status).toBe(204);
    const list = (await (await req('GET', '')).json()) as { credentials: { id: string }[] };
    expect(list.credentials.some((cr) => cr.id === credId)).toBe(false);
    expect((await req('DELETE', `/${credId}`)).status).toBe(404);
  });
});
