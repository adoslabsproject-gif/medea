/**
 * Tests per il logger runtime PSR-3 multi-canale (#194-bis).
 *
 * Stesso pattern del portal — verifica binding `channel` smistato per
 * prefisso `loggerFor(name)`.
 */

import { describe, it, expect } from 'vitest';
import { loggerFor, logger } from './logger.js';

function bindings(name: string): Record<string, unknown> {
  return loggerFor(name).bindings();
}

describe('loggerFor runtime — channel routing', () => {
  it('security.* / honeypot / sentinel / auth.* → channel="security"', () => {
    expect(bindings('security.threats').channel).toBe('security');
    expect(bindings('honeypot').channel).toBe('security');
    expect(bindings('sentinel.client').channel).toBe('security');
    expect(bindings('auth.middleware').channel).toBe('security');
  });

  it('audit.* / admin.* → channel="audit"', () => {
    expect(bindings('audit.chain').channel).toBe('audit');
    expect(bindings('admin.workflows').channel).toBe('audit');
  });

  it('http* / webhooks.* / dashboard.* → channel="http"', () => {
    expect(bindings('http').channel).toBe('http');
    expect(bindings('http-access').channel).toBe('http');
    expect(bindings('webhooks.stripe').channel).toBe('http');
    expect(bindings('dashboard.sse').channel).toBe('http');
  });

  it('liara.* / llm.* → channel="liara"', () => {
    expect(bindings('liara.gateway').channel).toBe('liara');
    expect(bindings('llm.tool-orchestrator').channel).toBe('liara');
  });

  it('perf.* / metrics.* → channel="performance"', () => {
    expect(bindings('perf.run-duration').channel).toBe('performance');
    expect(bindings('metrics.exporter').channel).toBe('performance');
  });

  it('system.* / cron.* / boot.* / lifecycle / engine.* → channel="system"', () => {
    expect(bindings('system.startup').channel).toBe('system');
    expect(bindings('cron.purge').channel).toBe('system');
    expect(bindings('boot.workflow-loader').channel).toBe('system');
    expect(bindings('lifecycle.sweeper').channel).toBe('system');
    expect(bindings('engine.workflow').channel).toBe('system');
  });

  it('default → channel="app"', () => {
    expect(bindings('executors.gmail').channel).toBe('app');
    expect(bindings('integrations.stripe').channel).toBe('app');
  });

  it('binding `module` aggiunto correttamente', () => {
    const b = bindings('honeypot.middleware');
    expect(b.module).toBe('honeypot.middleware');
    expect(b.channel).toBe('security');
  });

  it('logger base esposto + service flowforge-runtime', () => {
    expect(logger).toBeDefined();
    const b = logger.bindings();
    expect(b.service).toBe('flowforge-runtime');
  });
});
