/**
 * llm-providers.service tests — focus #208 P0-9.
 *
 * Pre-fix: `void audit.append(...)` fire-and-forget → se l'INSERT audit
 * fallisce (perm, FK, ecc.), il record di accountability sparisce ma
 * l'operazione di business (upsert/remove key) appare riuscita. Standard
 * GDPR audit-grade: ogni write deve essere DURABILE → await obbligatorio.
 *
 * Verifichiamo che:
 *  - upsert(...) → await audit.append (rejection si propaga al chiamante)
 *  - remove(...) → await audit.append (idem)
 *  - Liara è il provider speciale free-tier (no apiKey, no audit per upsert
 *    sans defaultModel, remove ritorna false)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  type SqlitePrepare = ReturnType<typeof vi.fn>;
  const prepare: SqlitePrepare = vi.fn();
  return {
    prepare,
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn().mockReturnValue({ changes: 1 }),
    auditAppend: vi.fn().mockResolvedValue(undefined),
    encryptSecret: vi.fn().mockReturnValue({
      ciphertext: 'ct', nonce: 'n', authTag: 't',
      dekCiphertext: 'dc', dekNonce: 'dn', dekAuthTag: 'dt',
    }),
    decryptSecret: vi.fn().mockReturnValue('plaintext-key'),
    loadMaster: vi.fn().mockReturnValue('master-fake-32-chars-min-padding!!!!'),
    isLiaraEnabled: vi.fn().mockReturnValue(true),
    liaraBaseUrl: vi.fn().mockReturnValue('https://liara.example.com'),
  };
});

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({
    sqlite: {
      prepare: (sql: string) => {
        m.prepare(sql);
        return {
          get: (...args: unknown[]) => m.get(sql, ...args),
          all: (...args: unknown[]) => m.all(sql, ...args),
          run: (...args: unknown[]) => m.run(sql, ...args),
        };
      },
    },
  }),
}));

vi.mock('@flowforge/secrets', () => ({
  encryptSecret: m.encryptSecret,
  decryptSecret: m.decryptSecret,
}));

vi.mock('./audit.service.js', () => ({
  AuditLogService: vi.fn().mockImplementation(() => ({
    append: m.auditAppend,
  })),
}));

vi.mock('./credentials.service.js', () => ({
  loadMaster: m.loadMaster,
}));

vi.mock('@/config.js', () => ({
  isLiaraEnabled: () => m.isLiaraEnabled(),
  liaraBaseUrl: () => m.liaraBaseUrl(),
}));

vi.mock('@/lib/logger.js');

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockReturnValue(undefined);  // no existing credential
  m.run.mockReturnValue({ changes: 1 });
  m.auditAppend.mockResolvedValue(undefined);
});

describe('#208 P0-9 — upsert await audit', () => {
  it('upsert(anthropic) chiama audit.append con await (no fire-and-forget)', async () => {
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    await svc.upsert('tenant-1', 'anthropic', { apiKey: 'sk-ant-test', actorId: 'user-1' });
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      action: 'llm_provider.upsert',
      resourceType: 'llm_provider',
      resourceId: 'anthropic',
      actorId: 'user-1',
    }));
  });

  it('upsert audit rejection PROPAGA al caller (await, no swallow)', async () => {
    m.auditAppend.mockRejectedValueOnce(new Error('audit DB down'));
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    await expect(
      svc.upsert('tenant-1', 'openai', { apiKey: 'sk-test' }),
    ).rejects.toThrow(/audit DB down/);
  });

  it('upsert(liara) senza defaultModel → no-op, NO audit', async () => {
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    await svc.upsert('tenant-1', 'liara', { apiKey: '' });
    expect(m.auditAppend).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
  });

  it('upsert(openai) senza apiKey → throw senza audit', async () => {
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    await expect(
      svc.upsert('tenant-1', 'openai', { apiKey: '' }),
    ).rejects.toThrow(/apiKey richiesta/);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });
});

describe('#208 P0-9 — remove await audit', () => {
  it('remove(anthropic) changes>0 → await audit.append + return true', async () => {
    m.run.mockReturnValueOnce({ changes: 1 });
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    const r = await svc.remove('tenant-1', 'anthropic', 'admin-1');
    expect(r).toBe(true);
    expect(m.auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      action: 'llm_provider.remove',
      resourceId: 'anthropic',
      actorId: 'admin-1',
    }));
  });

  it('remove changes=0 → NO audit + return false', async () => {
    m.run.mockReturnValueOnce({ changes: 0 });
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    const r = await svc.remove('tenant-1', 'gemini');
    expect(r).toBe(false);
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('remove(liara) → return false subito (free tier, no delete)', async () => {
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    const r = await svc.remove('tenant-1', 'liara');
    expect(r).toBe(false);
    expect(m.run).not.toHaveBeenCalled();
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('remove audit rejection PROPAGA al caller', async () => {
    m.run.mockReturnValueOnce({ changes: 1 });
    m.auditAppend.mockRejectedValueOnce(new Error('audit FK violation'));
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    await expect(svc.remove('tenant-1', 'mistral')).rejects.toThrow(/audit FK/);
  });
});

describe('list() — provider visibility rules (2026-05-29)', () => {
  // Regola: nel dropdown del client appaiono solo provider con `hasKey ||
  // freeTier`. Quindi senza credenziale configurata:
  //   - liara → SEMPRE visibile (freeTier=true)
  //   - ollama → NON visibile (freeTier=false dopo fix; serve install locale)
  //   - anthropic/openai/etc → NON visibili (richiedono API key)

  it('liara default = freeTier=true, hasKey=true (sempre disponibile)', async () => {
    m.all.mockReturnValueOnce([]); // nessuna credenziale stored
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    const list = svc.list('tenant-1');
    const liara = list.find((p) => p.provider === 'liara');
    expect(liara).toBeDefined();
    expect(liara!.freeTier).toBe(true);
    expect(liara!.hasKey).toBe(true);
  });

  it('REGRESSION: ollama NON è più freeTier (serve install + setup baseUrl)', async () => {
    m.all.mockReturnValueOnce([]);
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    const list = svc.list('tenant-1');
    const ollama = list.find((p) => p.provider === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.freeTier).toBe(false); // ← bug fix
    expect(ollama!.hasKey).toBe(false);    // no credenziale stored
    // Conseguenza UX (filtro client `hasKey || freeTier`): ollama NON appare
    // nel dropdown finché l'utente non registra la credenziale baseUrl.
  });

  it('anthropic/openai/gemini/mistral/groq/openrouter/voyage = freeTier=false', async () => {
    m.all.mockReturnValueOnce([]);
    const { LlmProvidersService } = await import('./llm-providers.service.js');
    const svc = new LlmProvidersService();
    const list = svc.list('tenant-1');
    const apiOnly = ['anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'voyage'];
    for (const p of apiOnly) {
      const entry = list.find((x) => x.provider === p);
      expect(entry, `provider ${p}`).toBeDefined();
      expect(entry!.freeTier, `provider ${p}`).toBe(false);
      expect(entry!.hasKey, `provider ${p}`).toBe(false);
    }
  });
});
