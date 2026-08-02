/**
 * Test 2026-grade — policy di sicurezza SSH-DB (PURA, deterministica).
 * Bug-bounty su: pinning obbligatorio, SSRF host SSH, read-only, segreti by-ref,
 * strict config. Le guardie engine/safe-fetch restano REALI (nessun mock).
 *
 * @module services/db-remote-ssh/__tests__/policy
 */
import { describe, it, expect } from 'vitest';
import {
  parseSshDbConfig,
  classifySshHost,
  assertSshHostAllowed,
  assertReadOnlyQuery,
  secretRefsOf,
  SshPolicyError,
  type SshDbConnectionConfig,
} from '../policy.js';

function validConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ssh: {
      host: '8.8.8.8', // IP pubblico reale (non riservato)
      port: 22,
      user: 'tunnel',
      hostKeyFingerprint: 'SHA256:abcdEFGH1234567890abcdefghIJKLmnopqrstuvwx',
      auth: { method: 'key', privateKeySecretRef: 'vault://ssh/key' },
    },
    db: {
      engine: 'postgres',
      host: '10.0.0.5',
      port: 5432,
      database: 'app',
      passwordSecretRef: 'vault://db/pw',
    },
    readOnly: true,
    ...over,
  };
}

describe('parseSshDbConfig — struttura & strict', () => {
  it('config valido → parse, default port 22 e readOnly true', () => {
    const c = parseSshDbConfig(
      validConfig({ ssh: { ...(validConfig().ssh as object), port: undefined } as object }),
    );
    expect(c.ssh.port).toBe(22);
    expect(c.readOnly).toBe(true);
  });

  it('🔒 fingerprint host-key MANCANTE → CONFIG (pinning obbligatorio, no TOFU)', () => {
    const cfg = validConfig();
    delete (cfg.ssh as Record<string, unknown>).hostKeyFingerprint;
    expect(() => parseSshDbConfig(cfg)).toThrow(SshPolicyError);
  });

  it('🔒 fingerprint vuoto / placeholder corto → CONFIG', () => {
    expect(() =>
      parseSshDbConfig(
        validConfig({ ssh: { ...(validConfig().ssh as object), hostKeyFingerprint: '' } }),
      ),
    ).toThrow(/fingerprint|CONFIG|host-key/i);
    expect(() =>
      parseSshDbConfig(
        validConfig({ ssh: { ...(validConfig().ssh as object), hostKeyFingerprint: 'x' } }),
      ),
    ).toThrow(SshPolicyError);
  });

  it('campo extra (strict) → CONFIG; rifiuta un eventuale "command" (no exec channel)', () => {
    expect(() => parseSshDbConfig(validConfig({ command: 'rm -rf /' }))).toThrow(SshPolicyError);
    const sshWithCmd = { ...(validConfig().ssh as object), command: 'whoami' };
    expect(() => parseSshDbConfig(validConfig({ ssh: sshWithCmd }))).toThrow(SshPolicyError);
  });

  it('porte fuori range / engine non supportato → CONFIG', () => {
    expect(() =>
      parseSshDbConfig(validConfig({ ssh: { ...(validConfig().ssh as object), port: 70000 } })),
    ).toThrow(SshPolicyError);
    expect(() =>
      parseSshDbConfig(
        validConfig({ db: { engine: 'oracle', host: 'h', port: 1, database: 'd' } }),
      ),
    ).toThrow(SshPolicyError);
  });

  it('auth password: solo passwordSecretRef; auth key: privateKeySecretRef obbligatorio', () => {
    const pw = parseSshDbConfig(
      validConfig({
        ssh: {
          ...(validConfig().ssh as object),
          auth: { method: 'password', passwordSecretRef: 'vault://p' },
        },
      }),
    );
    expect(pw.ssh.auth.method).toBe('password');
    // key senza privateKeySecretRef → CONFIG
    expect(() =>
      parseSshDbConfig(
        validConfig({ ssh: { ...(validConfig().ssh as object), auth: { method: 'key' } } }),
      ),
    ).toThrow(SshPolicyError);
  });
});

describe("🚨 SSRF guard sull'host SSH", () => {
  const blocked = [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254',
    '::1',
    '0.0.0.0',
  ];
  for (const ip of blocked) {
    it(`IP privato/riservato bloccato: ${ip}`, () => {
      expect(classifySshHost(ip).kind).toBe('ip-blocked');
      expect(() => assertSshHostAllowed(ip)).toThrow(SshPolicyError);
    });
  }

  it('IP pubblico ammesso', () => {
    expect(classifySshHost('8.8.8.8')).toEqual({ kind: 'ip-allowed' });
    expect(assertSshHostAllowed('1.1.1.1')).toEqual({ kind: 'ip-allowed' });
  });

  it('hostname → needs-dns (verifica DNS-aware demandata al connect)', () => {
    expect(classifySshHost('db.cliente.example.com').kind).toBe('hostname-needs-dns');
    expect(assertSshHostAllowed('bastion.acme.io')).toEqual({ kind: 'hostname-needs-dns' });
  });
});

describe('🚨 read-only enforcement (riusa classifyStatement reale)', () => {
  it('SELECT / EXPLAIN ammessi', () => {
    expect(() => assertReadOnlyQuery('SELECT * FROM clienti')).not.toThrow();
    expect(() => assertReadOnlyQuery('EXPLAIN SELECT 1')).not.toThrow();
  });

  const rejected = [
    'SELECT 1; DROP TABLE clienti',
    'DELETE FROM clienti',
    'UPDATE clienti SET x=1',
    'INSERT INTO clienti VALUES (1)',
    'CREATE TABLE evil(x int)',
    'WITH d AS (DELETE FROM clienti RETURNING *) SELECT 1',
    // BYPASS revisore 2026-06-14: DML PRIMARIO dopo CTE benigno (pre-fix "select").
    'WITH x AS (SELECT 1) DELETE FROM clienti WHERE id > 0',
    'WITH x AS (SELECT 1) UPDATE clienti SET x = 1',
    "SELECT load_extension('/tmp/evil.so')",
  ];
  for (const sql of rejected) {
    it(`rifiuta: ${sql.slice(0, 40)}`, () => {
      expect(() => assertReadOnlyQuery(sql)).toThrow(SshPolicyError);
    });
  }
});

describe('secretRefsOf — enumerazione segreti da risolvere', () => {
  it('auth key con passphrase + db user/pw', () => {
    const c = parseSshDbConfig(
      validConfig({
        ssh: {
          ...(validConfig().ssh as object),
          auth: { method: 'key', privateKeySecretRef: 'k', passphraseSecretRef: 'pp' },
        },
        db: {
          engine: 'mysql',
          host: 'h',
          port: 3306,
          database: 'd',
          userSecretRef: 'u',
          passwordSecretRef: 'pw',
        },
      }),
    ) as SshDbConnectionConfig;
    expect(secretRefsOf(c).sort()).toEqual(['k', 'pp', 'pw', 'u'].sort());
  });

  it('auth password senza db secret → un solo ref', () => {
    const c = parseSshDbConfig(
      validConfig({
        ssh: {
          ...(validConfig().ssh as object),
          auth: { method: 'password', passwordSecretRef: 'only' },
        },
        db: { engine: 'postgres', host: 'h', port: 5432, database: 'd' },
      }),
    );
    expect(secretRefsOf(c)).toEqual(['only']);
  });

  it('nessun segreto in chiaro nel config: i campi sono *SecretRef (riferimenti)', () => {
    const c = parseSshDbConfig(validConfig());
    const json = JSON.stringify(c);
    expect(json).not.toMatch(/-----BEGIN/); // niente chiave privata inline
    expect(json).toContain('SecretRef');
  });
});
