/**
 * Tests per master-password loader — file vs env vs dev-sentinel precedence.
 *
 * Copertura:
 *  - file (default path /run/secrets/...) ha precedenza su env
 *  - FLOWFORGE_MASTER_PASSWORD_FILE custom override
 *  - trailing newline strippato (Docker secrets convention)
 *  - BOM strippato (paranoia editor windows)
 *  - empty file → fallback
 *  - file inesistente → env fallback
 *  - production senza nulla → throw
 *  - dev senza nulla → sentinel
 *  - cache: re-call non rilegge il file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadMasterPassword,
  getMasterPasswordOrThrow,
  isFromSecretsFile,
  _resetMasterPasswordCacheForTest,
} from './master-password.js';

const ORIG_ENV = { ...process.env };
let tmpDir: string;
let secretFile: string;

beforeEach(() => {
  _resetMasterPasswordCacheForTest();
  tmpDir = mkdtempSync(join(tmpdir(), 'ff-mp-test-'));
  secretFile = join(tmpDir, 'master-password');
  delete process.env.FLOWFORGE_MASTER_PASSWORD;
  delete process.env.FLOWFORGE_MASTER_PASSWORD_FILE;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
});

describe('loadMasterPassword', () => {
  it('precedenza: file path esplicito vince su env var', () => {
    writeFileSync(secretFile, 'from-file-pw-32-chars-min-aaaaaa');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;
    process.env.FLOWFORGE_MASTER_PASSWORD = 'from-env-pw-should-be-ignored';

    const result = loadMasterPassword();
    expect(result.source).toBe('file');
    expect(result.password).toBe('from-file-pw-32-chars-min-aaaaaa');
    expect(result.path).toBe(secretFile);
  });

  it('precedenza: env var vince se file non esiste', () => {
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = '/nonexistent/file/path';
    process.env.FLOWFORGE_MASTER_PASSWORD = 'env-only-pw-fallback-aaaaaaaaaa';

    const result = loadMasterPassword();
    expect(result.source).toBe('env');
    expect(result.password).toBe('env-only-pw-fallback-aaaaaaaaaa');
    expect(result.path).toBeUndefined();
  });

  it('trailing newline (\\n) strippato dal file', () => {
    writeFileSync(secretFile, 'pw-with-trailing-newline-aaaaaa\n');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;

    expect(loadMasterPassword().password).toBe('pw-with-trailing-newline-aaaaaa');
  });

  it('trailing CRLF (\\r\\n) strippato dal file', () => {
    writeFileSync(secretFile, 'pw-with-trailing-crlf-aaaaaaaaaa\r\n');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;

    expect(loadMasterPassword().password).toBe('pw-with-trailing-crlf-aaaaaaaaaa');
  });

  it('BOM UTF-8 leading strippato', () => {
    writeFileSync(secretFile, '﻿pw-with-bom-prefix-aaaaaaaaaaaa');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;

    expect(loadMasterPassword().password).toBe('pw-with-bom-prefix-aaaaaaaaaaaa');
  });

  it('whitespace interno NON viene toccato (password con spazi legali)', () => {
    writeFileSync(secretFile, 'pw with internal spaces ok 123\n');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;

    expect(loadMasterPassword().password).toBe('pw with internal spaces ok 123');
  });

  it('file vuoto → fallback env', () => {
    writeFileSync(secretFile, '');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;
    process.env.FLOWFORGE_MASTER_PASSWORD = 'env-fallback-when-empty-aaaaaaaa';

    expect(loadMasterPassword().source).toBe('env');
  });

  it('produzione: niente file, niente env → throw', () => {
    process.env.NODE_ENV = 'production';

    expect(() => loadMasterPassword()).toThrow(/FLOWFORGE_MASTER_PASSWORD not found/);
  });

  it('dev: niente file, niente env → dev-sentinel', () => {
    process.env.NODE_ENV = 'development';

    const result = loadMasterPassword();
    expect(result.source).toBe('dev-sentinel');
    expect(result.password).toContain('development-only');
  });

  it('cache: seconda chiamata NON rilegge il file', () => {
    writeFileSync(secretFile, 'first-value-cached-aaaaaaaaaaaaa');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;

    expect(loadMasterPassword().password).toBe('first-value-cached-aaaaaaaaaaaaa');

    // Mutiamo il file. Senza reset cache, dovremmo ottenere il PRIMO valore.
    writeFileSync(secretFile, 'second-value-not-seen-aaaaaaaaa');
    expect(loadMasterPassword().password).toBe('first-value-cached-aaaaaaaaaaaaa');

    // Reset esplicito → rilegge.
    _resetMasterPasswordCacheForTest();
    expect(loadMasterPassword().password).toBe('second-value-not-seen-aaaaaaaaa');
  });

  it('getMasterPasswordOrThrow torna stringa', () => {
    writeFileSync(secretFile, 'pw-via-getter-aaaaaaaaaaaaaaaaaa');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;

    expect(getMasterPasswordOrThrow()).toBe('pw-via-getter-aaaaaaaaaaaaaaaaaa');
  });

  it('isFromSecretsFile = true solo per source file', () => {
    writeFileSync(secretFile, 'pw-from-file-test-aaaaaaaaaaaaaa');
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = secretFile;
    expect(isFromSecretsFile()).toBe(true);

    _resetMasterPasswordCacheForTest();
    delete process.env.FLOWFORGE_MASTER_PASSWORD_FILE;
    unlinkSync(secretFile);
    process.env.FLOWFORGE_MASTER_PASSWORD = 'env-not-file-aaaaaaaaaaaaaaaaaa';
    expect(isFromSecretsFile()).toBe(false);
  });

  it('path inesistente in FLOWFORGE_MASTER_PASSWORD_FILE → fallback graceful', () => {
    process.env.FLOWFORGE_MASTER_PASSWORD_FILE = '/tmp/definitely-does-not-exist-xyz-12345';
    process.env.FLOWFORGE_MASTER_PASSWORD = 'env-fallback-when-file-missing-aaa';

    expect(loadMasterPassword().source).toBe('env');
  });
});
