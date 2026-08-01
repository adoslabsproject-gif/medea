/**
 * Test 2026-grade — auth-keys.ts (session key pair bootstrap).
 *
 * 🚨 SECURITY-CRITICAL: questi sono i private/public keys per JWT signing.
 *    Bug = private key esposta / write-perm sbagliati / cache stantia.
 *
 * 🚨 INVARIANTI:
 *  - Cache singleton: 2x getAuthKeys() → 1 sola lettura disco (perf)
 *  - private key write mode 0o600 (rw user-only, no group/world)
 *  - First-run genera + persiste; runs successivi load da disco
 *  - mkdir recursive prima di write (boot first-time su volume nuovo)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fsMock = {
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const generateSessionKeyPairMock = vi.fn();
vi.mock('@flowforge/auth-local', () => ({
  generateSessionKeyPair: generateSessionKeyPairMock,
}));

const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('./logger.js', () => ({ logger: loggerMock }));

vi.mock('@/config.js', () => ({
  loadConfig: () => ({ FLOWFORGE_DATA_DIR: '/var/data/test' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('🚨 getAuthKeys — happy paths', () => {
  it('🚨 keys esistono su disco → read + return (NO regen)', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p.includes('private')) return 'PRIV-FROM-DISK';
      return 'PUB-FROM-DISK';
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    const k = await getAuthKeys();
    expect(k.privateKeyPem).toBe('PRIV-FROM-DISK');
    expect(k.publicKeyPem).toBe('PUB-FROM-DISK');
    expect(generateSessionKeyPairMock).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('🚨 keys NON esistono → genera + persiste + log first-run', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'PRIV-GENERATED',
      publicKeyPem: 'PUB-GENERATED',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    const k = await getAuthKeys();
    expect(k.privateKeyPem).toBe('PRIV-GENERATED');
    expect(k.publicKeyPem).toBe('PUB-GENERATED');
    expect(generateSessionKeyPairMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.stringMatching(/first-run/u),
    );
  });

  it('🚨 SECURITY: private key written with mode 0o600 (rw user only)', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'PRIV-X', publicKeyPem: 'PUB-X',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    // PRIVATE call: arg 3 = { mode: 0o600 }
    const privateWrite = fsMock.writeFileSync.mock.calls.find(
      (call) => String(call[0]).includes('private'),
    );
    expect(privateWrite).toBeDefined();
    expect(privateWrite![1]).toBe('PRIV-X');
    expect(privateWrite![2]).toEqual({ mode: 0o600 });
  });

  it('🚨 SECURITY: public key NON ha mode 0o600 (deve essere readable)', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'PRIV', publicKeyPem: 'PUB',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    const publicWrite = fsMock.writeFileSync.mock.calls.find(
      (call) => String(call[0]).includes('public') && !String(call[0]).includes('private'),
    );
    expect(publicWrite).toBeDefined();
    // Public key write SENZA mode option → default
    expect(publicWrite![2]).toBeUndefined();
  });

  it('🚨 mkdirSync recursive: true per supportare boot su volume nuovo', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'a', publicKeyPem: 'b',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      '/var/data/test', // dirname dell'inputpath
      { recursive: true },
    );
  });
});

describe('🚨 cache singleton — perf + consistency', () => {
  it('🚨 2x getAuthKeys() → 1 sola lettura disco', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('CACHED-KEY');
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    await getAuthKeys();
    await getAuthKeys();
    // readFileSync chiamato max 2 volte la PRIMA invocazione (priv + pub)
    expect(fsMock.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('🚨 2x getAuthKeys() → stesso oggetto reference (cache by ref)', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('K');
    const { getAuthKeys } = await import('./auth-keys.js');
    const k1 = await getAuthKeys();
    const k2 = await getAuthKeys();
    expect(k1).toBe(k2); // same reference
  });

  it('🚨 first-run + second call → 1 sola gen, 1 sola write', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'P', publicKeyPem: 'U',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    await getAuthKeys();
    expect(generateSessionKeyPairMock).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2); // priv + pub, MAI re-write
  });
});

describe('🚨 path construction — uses config.FLOWFORGE_DATA_DIR', () => {
  it('🚨 path priv = <DATA_DIR>/session-private.pem', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'a', publicKeyPem: 'b',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    const privateWrite = fsMock.writeFileSync.mock.calls.find(
      (call) => String(call[0]).includes('private'),
    );
    expect(String(privateWrite![0])).toBe('/var/data/test/session-private.pem');
  });

  it('🚨 path pub = <DATA_DIR>/session-public.pem', async () => {
    fsMock.existsSync.mockReturnValue(false);
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'a', publicKeyPem: 'b',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    await getAuthKeys();
    const publicWrite = fsMock.writeFileSync.mock.calls.find(
      (call) => String(call[0]).includes('public') && !String(call[0]).includes('private'),
    );
    expect(String(publicWrite![0])).toBe('/var/data/test/session-public.pem');
  });
});

describe('🚨 partial file existence — entrambi richiesti', () => {
  it('🚨 SOLO private esiste → REGEN (entrambi richiesti per cache)', async () => {
    // existsSync gets called 2x in code: privPath + pubPath con && (corto-circuito)
    let calls = 0;
    fsMock.existsSync.mockImplementation(() => {
      calls++;
      return calls === 1; // privPath true, pubPath false → cond false
    });
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'NEW-P', publicKeyPem: 'NEW-U',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    const k = await getAuthKeys();
    expect(k.privateKeyPem).toBe('NEW-P');
    expect(generateSessionKeyPairMock).toHaveBeenCalledTimes(1);
  });

  it('🚨 SOLO public esiste (no private) → REGEN', async () => {
    let calls = 0;
    fsMock.existsSync.mockImplementation(() => {
      calls++;
      return calls === 1 ? false : true; // privPath false → corto-circuito
    });
    generateSessionKeyPairMock.mockResolvedValue({
      privateKeyPem: 'X', publicKeyPem: 'Y',
    });
    const { getAuthKeys } = await import('./auth-keys.js');
    const k = await getAuthKeys();
    expect(k.privateKeyPem).toBe('X');
    expect(generateSessionKeyPairMock).toHaveBeenCalledTimes(1);
  });
});
