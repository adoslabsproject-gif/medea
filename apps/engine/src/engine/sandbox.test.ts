import { describe, it, expect } from 'vitest';
import { evaluateInSandbox, SandboxError } from './sandbox.js';

describe('isolated-vm sandbox (true V8 isolates)', () => {
  it('evaluates arithmetic', () => {
    expect(evaluateInSandbox('2 + 2', {})).toBe(4);
  });

  it('reads from input scope', () => {
    expect(evaluateInSandbox('input.foo', { input: { foo: 'bar' } })).toBe('bar');
  });

  it('boolean compare for if-node', () => {
    expect(evaluateInSandbox('input.status === "active"', { input: { status: 'active' } })).toBe(
      true,
    );
    expect(evaluateInSandbox('input.status === "active"', { input: { status: 'no' } })).toBe(false);
  });

  it('NO access to globalThis (isolated heap)', () => {
    expect(() =>
      evaluateInSandbox(
        'typeof globalThis === "undefined" ? "ok" : (function(){ globalThis.X = 1; return "leaked"; })()',
        {},
      ),
    ).not.toThrow();
    // globalThis exists in V8 but isolate has no host references on it
    expect(evaluateInSandbox('typeof process', {})).toBe('undefined');
    expect(evaluateInSandbox('typeof require', {})).toBe('undefined');
    expect(evaluateInSandbox('typeof Buffer', {})).toBe('undefined');
    expect(evaluateInSandbox('typeof setTimeout', {})).toBe('undefined');
  });

  it('rejects expressions over 4000 chars', () => {
    const huge = '1+'.repeat(2001) + '0';
    expect(() => evaluateInSandbox(huge, {})).toThrow(SandboxError);
  });

  it('enforces timeout on infinite loops', () => {
    expect(() =>
      evaluateInSandbox('(function(){ while(true){} })()', {}, { timeoutMs: 50 }),
    ).toThrow(SandboxError);
  });

  it('rejects __proto__ access at lexer level', () => {
    expect(() => evaluateInSandbox('input.__proto__', { input: {} })).toThrow(SandboxError);
  });

  it('rejects constructor.constructor escape', () => {
    expect(() => evaluateInSandbox('({}).constructor.constructor("return 1")()', {})).toThrow(
      SandboxError,
    );
  });

  it('supports optional chaining (handles undefined safely)', () => {
    expect(evaluateInSandbox('input?.missing?.deep', { input: {} })).toBeUndefined();
  });

  it('serializes return values via ExternalCopy', () => {
    const result = evaluateInSandbox('({ doubled: input.value * 2 })', { input: { value: 21 } });
    expect(result).toEqual({ doubled: 42 });
  });
});
