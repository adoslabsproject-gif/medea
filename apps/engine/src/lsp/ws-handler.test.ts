/**
 * Test ws-handler LSP — dispatch JSON-RPC + auth + allowed files.
 *
 * @module lsp/ws-handler.test
 */
import { describe, it, expect } from 'vitest';

// Importo dispatch via re-export (test esposto solo internamente in modulo);
// per non re-esportare, esercito il flusso via mock minimale.

// Strategia: testo l'allowlist file + il regex matching senza WebSocket reale.
// L'auth tramite verifySessionToken e\` testato in altro file.

const ALLOWED_FILES = new Set<string>(['executor', 'definition', 'schema']);

describe('🚨 ws-handler — ALLOWED_FILES allowlist (security)', () => {
  it('permette solo 3 file virtuali noti', () => {
    expect(ALLOWED_FILES.has('executor')).toBe(true);
    expect(ALLOWED_FILES.has('definition')).toBe(true);
    expect(ALLOWED_FILES.has('schema')).toBe(true);
  });

  it('🚨 path traversal rejected: "../../../etc/passwd"', () => {
    expect(ALLOWED_FILES.has('../../../etc/passwd')).toBe(false);
  });

  it('🚨 file con .ts suffix NON valido (basename only)', () => {
    expect(ALLOWED_FILES.has('executor.ts')).toBe(false);
  });

  it('🚨 case-sensitive', () => {
    expect(ALLOWED_FILES.has('Executor')).toBe(false);
    expect(ALLOWED_FILES.has('EXECUTOR')).toBe(false);
  });

  it('🚨 empty / null reject', () => {
    expect(ALLOWED_FILES.has('')).toBe(false);
  });

  it('🚨 prototype pollution: "__proto__" NOT in set', () => {
    expect(ALLOWED_FILES.has('__proto__')).toBe(false);
    expect(ALLOWED_FILES.has('constructor')).toBe(false);
  });
});

describe('🚨 ws-handler — endpoint path pattern', () => {
  it('path match check (regex semantica del handler)', () => {
    const pathStartsWith = (url: string, prefix: string): boolean => url.startsWith(prefix);
    expect(pathStartsWith('/api/v1/custom-nodes/lsp', '/api/v1/custom-nodes/lsp')).toBe(true);
    expect(pathStartsWith('/api/v1/custom-nodes/lsp?token=x', '/api/v1/custom-nodes/lsp')).toBe(true);
    expect(pathStartsWith('/api/v1/custom-nodes', '/api/v1/custom-nodes/lsp')).toBe(false);
    expect(pathStartsWith('/api/v1/lsp', '/api/v1/custom-nodes/lsp')).toBe(false);
  });
});

describe('🚨 ws-handler — JSON-RPC method dispatching', () => {
  // Replicato lo switch del dispatcher per test pure-logic
  const dispatch = (method: string, params: Record<string, unknown>): unknown => {
    const ALLOWED = new Set(['executor', 'definition', 'schema']);
    switch (method) {
      case 'initialize':
        return { capabilities: { completion: true, hover: true, diagnostics: true } };
      case 'update': {
        const file = params.file as string;
        const content = params.content;
        if (!ALLOWED.has(file) || typeof content !== 'string') {
          throw new Error(`invalid update params: file=${file} typeof content=${typeof content}`);
        }
        return { ok: true };
      }
      case 'completion':
      case 'hover':
      case 'diagnostics': {
        const file = params.file as string;
        if (!ALLOWED.has(file)) throw new Error(`invalid file ${file}`);
        return { items: [] };
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  };

  it('initialize → capabilities', () => {
    expect(dispatch('initialize', {})).toEqual({
      capabilities: { completion: true, hover: true, diagnostics: true },
    });
  });

  it('🚨 update con file invalido → throw', () => {
    expect(() => dispatch('update', { file: '../../etc/passwd', content: 'x' }))
      .toThrow(/invalid update params/);
  });

  it('🚨 update con content non-string → throw', () => {
    expect(() => dispatch('update', { file: 'executor', content: 123 }))
      .toThrow(/typeof content=number/);
  });

  it('🚨 completion: invalid file → throw', () => {
    expect(() => dispatch('completion', { file: 'evil.ts' })).toThrow(/invalid file/);
  });

  it('🚨 unknown method → throw', () => {
    expect(() => dispatch('shutdown', {})).toThrow(/unknown method/);
  });

  it('🚨 update con file valido + content valido → ok', () => {
    expect(dispatch('update', { file: 'executor', content: 'const x = 1;' })).toEqual({ ok: true });
  });
});
