/**
 * Test CustomNodeError typed error class hierarchy.
 *
 * @module services/custom-nodes/errors.test
 */
import { describe, it, expect } from 'vitest';
import {
  CustomNodeError,
  CustomNodeValidationError,
  CustomNodeNotFoundError,
  CustomNodeConflictError,
  CustomNodeQuotaExceededError,
  CustomNodeForbiddenError,
  CustomNodeCompileError,
  CustomNodeSecurityViolationError,
} from './errors.js';

describe('CustomNodeError base — status + code + meta', () => {
  it('costruisce con tutti i campi', () => {
    const e = new CustomNodeError({
      code: 'X',
      message: 'msg',
      status: 500,
      meta: { foo: 'bar' },
    });
    expect(e.code).toBe('X');
    expect(e.status).toBe(500);
    expect(e.meta).toEqual({ foo: 'bar' });
    expect(e.message).toBe('msg');
  });

  it('meta default {} se non fornito', () => {
    const e = new CustomNodeError({ code: 'X', message: 'm', status: 500 });
    expect(e.meta).toEqual({});
  });

  it('🚨 instanceof check funziona attraverso subclass', () => {
    const e = new CustomNodeValidationError('test');
    expect(e).toBeInstanceOf(CustomNodeValidationError);
    expect(e).toBeInstanceOf(CustomNodeError);
    expect(e).toBeInstanceOf(Error);
  });
});

describe('CustomNodeValidationError — 400', () => {
  it('status 400 + code CUSTOM_NODE_VALIDATION', () => {
    const e = new CustomNodeValidationError('bad input');
    expect(e.status).toBe(400);
    expect(e.code).toBe('CUSTOM_NODE_VALIDATION');
    expect(e.name).toBe('CustomNodeValidationError');
  });

  it('meta opzionale', () => {
    const e = new CustomNodeValidationError('bad', { field: 'slug' });
    expect(e.meta).toEqual({ field: 'slug' });
  });
});

describe('CustomNodeNotFoundError — 404', () => {
  it('status 404 + meta.id', () => {
    const e = new CustomNodeNotFoundError('node-123');
    expect(e.status).toBe(404);
    expect(e.code).toBe('CUSTOM_NODE_NOT_FOUND');
    expect(e.meta).toEqual({ id: 'node-123' });
    expect(e.message).toContain('node-123');
  });
});

describe('CustomNodeConflictError — 409', () => {
  it('status 409', () => {
    expect(new CustomNodeConflictError('slug duplicato').status).toBe(409);
  });
});

describe('🚨 CustomNodeQuotaExceededError — 402', () => {
  it('status 402 + meta con limit details', () => {
    const e = new CustomNodeQuotaExceededError({
      current: 5,
      limit: 5,
      planCode: 'free',
      suggestedPlan: 'pro',
    });
    expect(e.status).toBe(402);
    expect(e.code).toBe('CUSTOM_NODE_QUOTA_EXCEEDED');
    expect(e.message).toContain('5/5');
    expect(e.message).toContain('free');
    expect(e.message).toContain('pro');
  });

  it('suggestedPlan opzionale (no "Upgrade to" se omitted)', () => {
    const e = new CustomNodeQuotaExceededError({
      current: 5,
      limit: 5,
      planCode: 'enterprise',
    });
    expect(e.message).not.toContain('Upgrade');
  });
});

describe('CustomNodeForbiddenError — 403', () => {
  it('status 403', () => {
    expect(new CustomNodeForbiddenError('Only workspace owner can edit').status).toBe(403);
  });
});

describe('🚨 CustomNodeCompileError — 422 (TS errors)', () => {
  it('status 422 + meta diagnostics', () => {
    const diagnostics = [{ line: 5, col: 10, message: 'Type X' }];
    const e = new CustomNodeCompileError('compile failed', {
      diagnostics,
      sourceFile: 'executor.ts',
    });
    expect(e.status).toBe(422);
    expect(e.code).toBe('CUSTOM_NODE_COMPILE_ERROR');
    expect(e.meta).toEqual({ diagnostics, sourceFile: 'executor.ts' });
  });
});

describe('🚨 CustomNodeSecurityViolationError — 422 (forbidden import/eval)', () => {
  it('status 422 + meta violation details', () => {
    const e = new CustomNodeSecurityViolationError('eval() not allowed', {
      pattern: 'eval',
      line: 42,
      file: 'executor.ts',
    });
    expect(e.status).toBe(422);
    expect(e.code).toBe('CUSTOM_NODE_SECURITY_VIOLATION');
    expect(e.message).toContain('eval()');
    expect(e.meta).toMatchObject({ pattern: 'eval', line: 42 });
  });
});

describe('🚨 catch instanceof CustomNodeError matches ANY subclass', () => {
  it('single catch handle tutte le subclass', () => {
    const errors: CustomNodeError[] = [
      new CustomNodeValidationError('a'),
      new CustomNodeNotFoundError('b'),
      new CustomNodeQuotaExceededError({ current: 1, limit: 1, planCode: 'p' }),
      new CustomNodeForbiddenError('c'),
      new CustomNodeCompileError('d', {}),
      new CustomNodeSecurityViolationError('e', {}),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(CustomNodeError);
      expect(typeof e.status).toBe('number');
      expect(typeof e.code).toBe('string');
    }
  });
});
