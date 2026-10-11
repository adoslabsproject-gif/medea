/**
 * TenantAiPreferencesService, su SQLite vero in memoria.
 *
 *  - get/set del provider predefinito, coi valori di chi non ha mai scelto
 *  - resolveDefaultProvider: la preferenza vale solo se quel provider è
 *    configurato; altrimenti il primo configurato; altrimenti niente
 *  - le preferenze di un tenant non arrivano a un altro
 *  - una stringa vuota o di soli spazi vale «nessuna preferenza»
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));

vi.mock('@/storage/db.js', () => ({
  getDatabase: () => ({ sqlite: m.db! }),
}));

import { TenantAiPreferencesService } from './tenant-ai-preferences.service.js';

beforeEach(() => {
  m.db = new Database(':memory:');
  m.db.exec(`
    CREATE TABLE tenant_ai_preferences (
      tenant_id TEXT PRIMARY KEY,
      default_llm_provider TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
});

describe('get — defaults', () => {
  it('riga assente → nessuna preferenza', () => {
    expect(new TenantAiPreferencesService().get('t1')).toEqual({ defaultLlmProvider: null });
  });

  it('riga presente → riflette il valore salvato', () => {
    m.db!.prepare(
      'INSERT INTO tenant_ai_preferences (tenant_id, default_llm_provider, updated_at) VALUES (?, ?, ?)',
    ).run('t1', 'anthropic', '2026-06-07T00:00:00.000Z');
    expect(new TenantAiPreferencesService().get('t1')).toEqual({
      defaultLlmProvider: 'anthropic',
    });
  });

  it.each(['', '   '])('valore "%s" → normalizzato a nessuna preferenza', (vuoto) => {
    m.db!.prepare(
      'INSERT INTO tenant_ai_preferences (tenant_id, default_llm_provider) VALUES (?, ?)',
    ).run('t1', vuoto);
    expect(new TenantAiPreferencesService().get('t1').defaultLlmProvider).toBeNull();
  });
});

describe('set', () => {
  it('salva e rilegge', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'openai' });
    expect(svc.get('t1').defaultLlmProvider).toBe('openai');
  });

  it('una seconda scrittura aggiorna la stessa riga', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'openai' });
    svc.set('t1', { defaultLlmProvider: 'gemini' });
    expect(svc.get('t1').defaultLlmProvider).toBe('gemini');
    const righe = m.db!.prepare('SELECT COUNT(*) AS c FROM tenant_ai_preferences').get() as {
      c: number;
    };
    expect(righe.c).toBe(1);
  });

  it('null cancella la preferenza', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'openai' });
    svc.set('t1', { defaultLlmProvider: null });
    expect(svc.get('t1').defaultLlmProvider).toBeNull();
  });

  it('una patch vuota non tocca la preferenza esistente', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('t1', { defaultLlmProvider: 'openai' });
    svc.set('t1', {});
    expect(svc.get('t1').defaultLlmProvider).toBe('openai');
  });

  it('le preferenze di un tenant non arrivano a un altro', () => {
    const svc = new TenantAiPreferencesService();
    svc.set('tA', { defaultLlmProvider: 'openai' });
    expect(svc.get('tB').defaultLlmProvider).toBeNull();
  });
});

describe('resolveDefaultProvider', () => {
  const svc = (): TenantAiPreferencesService => new TenantAiPreferencesService();

  it('🚨 niente configurato → null: chi chiama deve dirlo, non ripiegare', () => {
    expect(svc().resolveDefaultProvider('t1', [])).toBeNull();
  });

  it('nessuna preferenza → il primo provider configurato, nell’ordine ricevuto', () => {
    expect(
      svc().resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: true },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('openai');
  });

  it('un provider senza chiave non è utilizzabile, nemmeno se è il primo', () => {
    expect(
      svc().resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: false },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('anthropic');
  });

  it('la preferenza vince sull’ordine, se quel provider è configurato', () => {
    const s = svc();
    s.set('t1', { defaultLlmProvider: 'anthropic' });
    expect(
      s.resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: true },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('anthropic');
  });

  it('una preferenza per un provider senza chiave viene ignorata', () => {
    const s = svc();
    s.set('t1', { defaultLlmProvider: 'anthropic' });
    expect(
      s.resolveDefaultProvider('t1', [
        { provider: 'openai', hasKey: true },
        { provider: 'anthropic', hasKey: false },
      ]),
    ).toBe('openai');
  });

  /**
   * Una preferenza può nominare un provider che in questa versione non esiste
   * più. Non essendo fra i configurati, non viene onorata: decide il primo
   * configurato, e se non ce n'è nessuno la risposta è «niente».
   */
  it('🚨 una preferenza per un provider che non esiste più viene ignorata', () => {
    const s = svc();
    s.set('t1', { defaultLlmProvider: 'provider-dismesso' });
    expect(s.resolveDefaultProvider('t1', [{ provider: 'openai', hasKey: true }])).toBe('openai');
    expect(s.resolveDefaultProvider('t1', [])).toBeNull();
  });

  it('la preferenza di un tenant non decide per un altro', () => {
    const s = svc();
    s.set('tA', { defaultLlmProvider: 'anthropic' });
    expect(
      s.resolveDefaultProvider('tB', [
        { provider: 'openai', hasKey: true },
        { provider: 'anthropic', hasKey: true },
      ]),
    ).toBe('openai');
  });
});
