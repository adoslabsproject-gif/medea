/**
 * Test integrazione llm-providers — DB REALE (better-sqlite3 in-memory) per
 * catturare il vincolo UNIQUE che il mock non vede.
 *
 * Bug owner 2026-06-17: `UNIQUE(tenant_id, name)` + `name` COSTANTE per tutti i
 * provider ⇒ il 2° provider per tenant violava il vincolo → un solo provider
 * per tenant. La BYOK deve funzionare con TUTTI i provider. Qui salviamo 3
 * provider sullo stesso tenant e verifichiamo che convivano + round-trip get().
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type * as CredentialsServiceModule from './credentials.service.js';

const db = new Database(':memory:');

vi.mock('@/storage/db.js', () => ({ getDatabase: () => ({ sqlite: db }) }));
vi.mock('@/lib/logger.js');
// audit + secrets mockati: niente master password reale, encrypt/decrypt passthrough
// (il name è AAD ma qui è irrilevante — decrypt ritorna il plaintext registrato).
vi.mock('./audit.service.js', () => ({
  AuditLogService: class {
    append = vi.fn().mockResolvedValue(undefined);
  },
}));
const store = new Map<string, string>();
vi.mock('@medea/engine-secrets', () => ({
  encryptSecret: (s: { id: string; plaintext: string }) => {
    store.set(s.id, s.plaintext);
    return {
      ciphertext: s.id,
      nonce: 'n',
      authTag: 't',
      dekCiphertext: 'dc',
      dekNonce: 'dn',
      dekAuthTag: 'dt',
    };
  },
  decryptSecret: (e: { ciphertext: string }) => store.get(e.ciphertext) ?? '',
}));
vi.mock('@/config.js', () => ({
  liaraBaseUrl: () => 'https://liara.local',
  isLiaraEnabled: () => true,
}));
vi.mock('@/services/credentials.service.js', async () => {
  const actual = await vi.importActual<typeof CredentialsServiceModule>('./credentials.service.js');
  return { ...actual, loadMaster: () => 'master-fake-32chars-padding!!!!!!!!' };
});

const { ensureCredentialsTable } = await import('./credentials.service.js');
const { LlmProvidersService } = await import('./llm-providers.service.js');

beforeEach(() => {
  db.exec('DROP TABLE IF EXISTS user_credentials');
  ensureCredentialsTable();
  store.clear();
});

describe('🚨 BYOK multi-provider per tenant (UNIQUE bug)', () => {
  it('🚨 salva 3 provider sullo STESSO tenant senza violare UNIQUE(tenant_id,name)', async () => {
    const svc = new LlmProvidersService();
    await svc.upsert('t1', 'anthropic', { apiKey: 'sk-ant-1' });
    await svc.upsert('t1', 'openai', { apiKey: 'sk-oa-2' }); // ← prima: UNIQUE failed
    await svc.upsert('t1', 'gemini', { apiKey: 'sk-gm-3' });
    const configured = new Set(
      svc
        .list('t1')
        .filter((p) => p.hasKey)
        .map((p) => p.provider),
    );
    // i 3 BYOK convivono (oltre a liara free-tier sempre presente)
    expect(configured.has('anthropic')).toBe(true);
    expect(configured.has('openai')).toBe(true);
    expect(configured.has('gemini')).toBe(true);
    // a livello DB: 3 righe llm distinte
    const cnt = (
      db
        .prepare(
          "SELECT COUNT(*) c FROM user_credentials WHERE tenant_id='t1' AND provider LIKE 'llm:%'",
        )
        .get() as { c: number }
    ).c;
    expect(cnt).toBe(3);
  });

  it('🚨 round-trip: ogni provider decritta la PROPRIA key (nessun cross-talk)', async () => {
    const svc = new LlmProvidersService();
    await svc.upsert('t1', 'anthropic', { apiKey: 'KEY-ANTHROPIC' });
    await svc.upsert('t1', 'openai', { apiKey: 'KEY-OPENAI' });
    expect(svc.get('t1', 'anthropic')?.apiKey).toBe('KEY-ANTHROPIC');
    expect(svc.get('t1', 'openai')?.apiKey).toBe('KEY-OPENAI');
  });

  it('🚨 re-upsert dello stesso provider AGGIORNA (non duplica) + risana il name legacy', async () => {
    const svc = new LlmProvidersService();
    await svc.upsert('t1', 'openai', { apiKey: 'v1' });
    // simula riga LEGACY con name costante 'default' (pre-fix)
    db.prepare("UPDATE user_credentials SET name = 'default' WHERE provider = 'llm:openai'").run();
    await svc.upsert('t1', 'openai', { apiKey: 'v2' }); // trova per provider, UPDATE
    const rows = db
      .prepare("SELECT name FROM user_credentials WHERE tenant_id='t1' AND provider='llm:openai'")
      .all() as { name: string }[];
    expect(rows).toHaveLength(1); // nessun duplicato
    expect(rows[0]!.name).toBe('llm:openai'); // name risanato
    expect(svc.get('t1', 'openai')?.apiKey).toBe('v2');
  });

  it('isolamento per-tenant: t2 non vede le key di t1', async () => {
    const svc = new LlmProvidersService();
    await svc.upsert('t1', 'openai', { apiKey: 'k1' });
    expect(svc.get('t2', 'openai')).toBeNull();
  });
});
