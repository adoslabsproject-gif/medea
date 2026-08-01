/**
 * Test 2026-grade — VaultSecretsService (HashiCorp Vault KV v2).
 *
 * 🚨 SECURITY: token X-Vault-Token header mai loggato; namespace opzionale.
 * 🚨 RESILIENCE: cache TTL per evitare flood Vault server; fail-closed null.
 * 🚨 PARSING: vault:<mount>/[data/]<path>#<key> (data/ opzionale per UX).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger.js';
import { at } from '@/__testkit__/assert.js';

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.FLOWFORGE_VAULT_ADDR;
  delete process.env.FLOWFORGE_VAULT_TOKEN;
  delete process.env.FLOWFORGE_VAULT_NAMESPACE;
  delete process.env.FLOWFORGE_VAULT_CACHE_TTL_MS;
});

async function loadFresh() {
  return import('./vault-secrets.service.js');
}

describe('🚨 isConfigured', () => {
  it('🚨 addr+token presenti → true', async () => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault.example.com';
    process.env.FLOWFORGE_VAULT_TOKEN = 'hvs.token-xxx';
    const { VaultSecretsService } = await loadFresh();
    expect(new VaultSecretsService().isConfigured()).toBe(true);
  });

  it('🚨 addr mancante → false', async () => {
    process.env.FLOWFORGE_VAULT_TOKEN = 'hvs.token';
    const { VaultSecretsService } = await loadFresh();
    expect(new VaultSecretsService().isConfigured()).toBe(false);
  });

  it('🚨 token mancante → false', async () => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault';
    const { VaultSecretsService } = await loadFresh();
    expect(new VaultSecretsService().isConfigured()).toBe(false);
  });
});

describe('🚨 resolve — parsing vault:* reference', () => {
  it('🚨 nome non vault:* → undefined (non-vault ref)', async () => {
    const { VaultSecretsService } = await loadFresh();
    const out = await new VaultSecretsService().resolve('local-credential-name');
    expect(out).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('🚨 vault:* senza #key → null (parse fail)', async () => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault';
    process.env.FLOWFORGE_VAULT_TOKEN = 'tok';
    const { VaultSecretsService } = await loadFresh();
    expect(await new VaultSecretsService().resolve('vault:secret/myapp/db')).toBeUndefined();
  });

  it('🚨 vault:* mount only senza path → undefined (parse fail)', async () => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault';
    process.env.FLOWFORGE_VAULT_TOKEN = 'tok';
    const { VaultSecretsService } = await loadFresh();
    expect(await new VaultSecretsService().resolve('vault:secret#key')).toBeUndefined();
  });

  it('🚨 vault:* MA Vault non configurato → null + warn', async () => {
    const { VaultSecretsService } = await loadFresh();
    const out = await new VaultSecretsService().resolve('vault:secret/data/myapp#password');
    expect(out).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ credentialName: 'vault:secret/data/myapp#password' }),
      expect.stringContaining('FLOWFORGE_VAULT_ADDR/TOKEN'),
    );
  });
});

describe('🚨 resolve — happy fetch', () => {
  beforeEach(() => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault.example.com';
    process.env.FLOWFORGE_VAULT_TOKEN = 'hvs.secret-token-AAA';
  });

  it('🚨 happy path: KV v2 read → ritorna value', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { data: { password: 'super-secret-pwd' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    const out = await new VaultSecretsService().resolve('vault:secret/data/myapp/db#password');
    expect(out).toBe('super-secret-pwd');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = at(fetchMock.mock.calls, 0, 'fetch-calls');
    expect(String(url)).toBe('https://vault.example.com/v1/secret/data/myapp/db');
    expect((opts as RequestInit).headers).toEqual(expect.objectContaining({
      'X-Vault-Token': 'hvs.secret-token-AAA',
    }));
  });

  it('🚨 path senza "data/" middle → auto-resolved', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { api_key: 'k-123' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    const out = await new VaultSecretsService().resolve('vault:secret/myapp/db#api_key');
    expect(out).toBe('k-123');
    const url = String(at(fetchMock.mock.calls, 0, 'fetch-calls')[0]);
    expect(url).toBe('https://vault.example.com/v1/secret/data/myapp/db');
  });

  it('🚨 namespace propagato come header X-Vault-Namespace', async () => {
    process.env.FLOWFORGE_VAULT_NAMESPACE = 'admin/team-alpha';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { x: 'y' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    await new VaultSecretsService().resolve('vault:secret/data/app#x');
    const headers = (at(fetchMock.mock.calls, 0, 'fetch-calls')[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Vault-Namespace']).toBe('admin/team-alpha');
  });

  it('🚨 trailing slash in addr → normalizzato', async () => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault.example.com///';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k: 'v' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    await new VaultSecretsService().resolve('vault:secret/data/app#k');
    expect(String(at(fetchMock.mock.calls, 0, 'fetch-calls')[0])).toBe('https://vault.example.com/v1/secret/data/app');
  });
});

describe('🚨 resolve — failure modes', () => {
  beforeEach(() => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault.example.com';
    process.env.FLOWFORGE_VAULT_TOKEN = 'tok';
  });

  it('🚨 res non ok (403 token revoked) → null + error log', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('permission denied'),
    });
    const { VaultSecretsService } = await loadFresh();
    expect(await new VaultSecretsService().resolve('vault:secret/data/app#x')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403 }),
      'Vault KV read failed',
    );
  });

  it('🚨 res ok ma key non in response.data.data → null + warn', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { other_key: 'value' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    expect(await new VaultSecretsService().resolve('vault:secret/data/app#missing_key')).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'missing_key' }),
      'Vault secret missing requested key',
    );
  });

  it('🚨 fetch throw (network) → null + error log', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { VaultSecretsService } = await loadFresh();
    expect(await new VaultSecretsService().resolve('vault:secret/data/app#x')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Vault fetch threw',
    );
  });

  it('🚨 value tipo non-string → null', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { x: 42 } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    expect(await new VaultSecretsService().resolve('vault:secret/data/app#x')).toBeNull();
  });
});

describe('🚨 cache TTL — anti-flood Vault server', () => {
  beforeEach(() => {
    process.env.FLOWFORGE_VAULT_ADDR = 'https://vault';
    process.env.FLOWFORGE_VAULT_TOKEN = 'tok';
  });

  it('🚨 2x resolve stesso path → 1 fetch, cached', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k: 'cached-value' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    const svc = new VaultSecretsService();
    expect(await svc.resolve('vault:secret/data/app#k')).toBe('cached-value');
    expect(await svc.resolve('vault:secret/data/app#k')).toBe('cached-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 TTL expired → re-fetch', async () => {
    vi.useFakeTimers();
    process.env.FLOWFORGE_VAULT_CACHE_TTL_MS = '1000';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k: 'v1' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    const svc = new VaultSecretsService();
    expect(await svc.resolve('vault:secret/data/app#k')).toBe('v1');
    vi.advanceTimersByTime(2000);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k: 'v2' } } }),
    });
    expect(await svc.resolve('vault:secret/data/app#k')).toBe('v2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('🚨 cache key è per-path+key (2 secret diversi → 2 fetch)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k1: 'v1' } } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k2: 'v2' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    const svc = new VaultSecretsService();
    expect(await svc.resolve('vault:secret/data/app1#k1')).toBe('v1');
    expect(await svc.resolve('vault:secret/data/app2#k2')).toBe('v2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('🚨 failed fetch NON cached (retry su prossima chiamata)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('') });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { data: { k: 'eventual-success' } } }),
    });
    const { VaultSecretsService } = await loadFresh();
    const svc = new VaultSecretsService();
    expect(await svc.resolve('vault:secret/data/app#k')).toBeNull();
    expect(await svc.resolve('vault:secret/data/app#k')).toBe('eventual-success');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
