/**
 * Test egress-policy — allowlist persistita in system_flags + push a caldo + fallback env.
 * 🚨 SECURITY: host pubblico MAI allowlisted; insecure-TLS solo se allowSelfSigned; push
 * vince/sostituisce; fail-CLOSED su errore DB; vuota = OFF.
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('@/lib/logger.js');

// DB in-memory iniettato in getDatabase (holder per la hoist di vi.mock).
const holder: { db: Database.Database | null; throwOnGet: boolean } = { db: null, throwOnGet: false };
vi.mock('@/storage/db.js', () => ({
  getDatabase: () => {
    if (holder.throwOnGet) throw new Error('DB down');
    const db = holder.db!;
    return {
      sqlite: {
        prepare: (sql: string) => { const s = db.prepare(sql); return { run: (...p: unknown[]) => s.run(...p), get: (...p: unknown[]) => s.get(...p), all: (...p: unknown[]) => s.all(...p) }; },
        exec: (sql: string) => { db.exec(sql); },
        transaction: (fn: unknown) => fn,
      },
    };
  },
}));

const { resolveOutboundDispatcher, setEgressAllowlist, __resetEgressAllowlistForTest } = await import('./egress-policy.js');
const { getInsecureTlsDispatcher, getPermissiveDispatcher, __resetSecureDispatcherForTest } = await import('./secure-dispatcher.js');

const ENV = 'MEDEA_INTERNAL_HOST_ALLOWLIST';
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[ENV];
  delete process.env[ENV];
  holder.db = new Database(':memory:');
  holder.db.exec('CREATE TABLE system_flags (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  holder.throwOnGet = false;
  __resetEgressAllowlistForTest();
  __resetSecureDispatcherForTest();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV]; else process.env[ENV] = prevEnv;
  holder.db?.close();
});

describe('resolveOutboundDispatcher — allowlist DB-backed', () => {
  it('🚨 allowlist vuota (no flag, no env) → host interno NON allowlisted (feature OFF, #201)', () => {
    expect(resolveOutboundDispatcher('erp.internal', true)).toEqual({ allowlisted: false });
  });

  it('fallback ENV quando il flag DB non è ancora scritto (bootstrap/legacy)', () => {
    process.env[ENV] = 'erp.internal';
    __resetEgressAllowlistForTest();
    expect(resolveOutboundDispatcher('erp.internal', false).allowlisted).toBe(true);
  });

  it('🚨 host PUBBLICO → false anche con allowSelfSigned (no MITM)', () => {
    setEgressAllowlist('erp.internal');
    expect(resolveOutboundDispatcher('api.stripe.com', true)).toEqual({ allowlisted: false });
  });

  it('allowlisted + allowSelfSigned=true → dispatcher INSECURE-TLS', () => {
    setEgressAllowlist('erp.internal');
    const r = resolveOutboundDispatcher('erp.internal', true);
    expect(r.allowlisted).toBe(true);
    expect(r.dispatcher).toBe(getInsecureTlsDispatcher());
  });

  it('allowlisted + allowSelfSigned=false → dispatcher PERMISSIVO (TLS verificato)', () => {
    setEgressAllowlist('erp.internal');
    const r = resolveOutboundDispatcher('erp.internal', false);
    expect(r.dispatcher).toBe(getPermissiveDispatcher());
    expect(r.dispatcher).not.toBe(getInsecureTlsDispatcher());
  });

  it('🚨 push PERSISTE + sopravvive al reset cache (riletto dal DB)', () => {
    setEgressAllowlist('erp.internal');
    __resetEgressAllowlistForTest(); // simula restart container (cache persa, DB resta)
    expect(resolveOutboundDispatcher('erp.internal', false).allowlisted).toBe(true);
  });

  it('🚨 push VINCE sull\'env e lo svuotamento DISATTIVA tutto', () => {
    process.env[ENV] = 'da-env.internal';
    __resetEgressAllowlistForTest();
    setEgressAllowlist('pushed.internal');
    expect(resolveOutboundDispatcher('pushed.internal', false).allowlisted).toBe(true);
    expect(resolveOutboundDispatcher('da-env.internal', false).allowlisted).toBe(false);
    setEgressAllowlist(''); // admin svuota
    expect(resolveOutboundDispatcher('pushed.internal', true).allowlisted).toBe(false);
  });

  it('🚨 FAIL-CLOSED: errore lettura DB → allowlist vuota (nessun bypass)', () => {
    process.env[ENV] = 'erp.internal'; // anche con env valorizzato
    holder.throwOnGet = true;
    __resetEgressAllowlistForTest();
    expect(resolveOutboundDispatcher('erp.internal', true)).toEqual({ allowlisted: false });
  });
});
