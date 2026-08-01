import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseConfig, parseConfigOrThrow, defineConfigSchema, commonSchemas } from './config-parser.js';
import { ValidationError } from './node-error.js';

describe('config-parser', () => {
  describe('parseConfig', () => {
    const schema = z.object({
      url: z.string().url(),
      retries: z.coerce.number().int().min(0).max(10).default(3),
    });

    it('returns ok with parsed + defaulted value', () => {
      const r = parseConfig(schema, { url: 'https://x.com' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ url: 'https://x.com', retries: 3 });
    });

    it('coerces string numbers via z.coerce', () => {
      const r = parseConfig(schema, { url: 'https://x.com', retries: '5' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.retries).toBe(5);
    });

    it('returns err with ValidationError on missing required field', () => {
      const r = parseConfig(schema, { retries: 3 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(ValidationError);
        expect(r.error.message).toContain('url');
      }
    });

    it('returns err with ValidationError on type mismatch (URL not URL)', () => {
      const r = parseConfig(schema, { url: 'not a url' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('url');
    });

    it('includes issues array in error context', () => {
      const r = parseConfig(schema, { url: 'bad', retries: -5 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const issues = r.error.context.issues as { path: (string | number)[] }[];
        expect(Array.isArray(issues)).toBe(true);
        expect(issues.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('formats multi-issue message with field paths joined by " · "', () => {
      const r = parseConfig(schema, { url: 'bad', retries: 99 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/url:.*retries:/u);
    });
  });

  describe('parseConfigOrThrow', () => {
    it('returns value on success', () => {
      const r = parseConfigOrThrow(z.object({ a: z.string() }), { a: 'x' });
      expect(r).toEqual({ a: 'x' });
    });

    it('throws ValidationError on failure', () => {
      expect(() => parseConfigOrThrow(z.object({ a: z.string() }), { a: 5 }))
        .toThrow(ValidationError);
    });
  });

  describe('defineConfigSchema', () => {
    it('creates passthrough object schema (accetta campi extra)', () => {
      const s = defineConfigSchema({ url: z.string() });
      const r = parseConfig(s, { url: 'https://x.com', extraField: 'kept' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.extraField).toBe('kept');
    });

    it('still enforces declared fields', () => {
      const s = defineConfigSchema({ url: z.string() });
      const r = parseConfig(s, { url: 123 });
      expect(r.ok).toBe(false);
    });
  });

  describe('commonSchemas.positiveInt', () => {
    it('accepts positive int', () => {
      const r = commonSchemas.positiveInt().safeParse(5);
      expect(r.success).toBe(true);
    });

    it('rejects zero / negative', () => {
      expect(commonSchemas.positiveInt().safeParse(0).success).toBe(false);
      expect(commonSchemas.positiveInt().safeParse(-1).success).toBe(false);
    });

    it('applies default if provided + undefined input', () => {
      const r = commonSchemas.positiveInt(42).safeParse(undefined);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(42);
    });

    it('coerces string', () => {
      const r = commonSchemas.positiveInt().safeParse('5');
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(5);
    });
  });

  describe('commonSchemas.timeoutMs', () => {
    it('caps at 10 minutes (600_000)', () => {
      expect(commonSchemas.timeoutMs().safeParse(900_000).success).toBe(false);
      expect(commonSchemas.timeoutMs().safeParse(600_000).success).toBe(true);
    });

    it('default 30s', () => {
      const r = commonSchemas.timeoutMs().safeParse(undefined);
      if (r.success) expect(r.data).toBe(30_000);
    });
  });

  describe('commonSchemas.httpUrl', () => {
    it('accepts http and https', () => {
      expect(commonSchemas.httpUrl().safeParse('http://x.com').success).toBe(true);
      expect(commonSchemas.httpUrl().safeParse('https://x.com').success).toBe(true);
    });

    it('rejects ftp / file / data', () => {
      expect(commonSchemas.httpUrl().safeParse('ftp://x.com').success).toBe(false);
      expect(commonSchemas.httpUrl().safeParse('file:///etc/passwd').success).toBe(false);
      expect(commonSchemas.httpUrl().safeParse('data:text/html,test').success).toBe(false);
    });
  });

  describe('commonSchemas.boolish', () => {
    it('accepts boolean true/false', () => {
      const s = commonSchemas.boolish();
      expect(s.safeParse(true).data).toBe(true);
      expect(s.safeParse(false).data).toBe(false);
    });

    it('coerces string literals', () => {
      const s = commonSchemas.boolish();
      expect(s.safeParse('true').data).toBe(true);
      expect(s.safeParse('false').data).toBe(false);
    });

    it('applies default on undefined', () => {
      const r = commonSchemas.boolish(true).safeParse(undefined);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(true);
    });
  });

  describe('commonSchemas.kvJsonString', () => {
    it('parses valid JSON object to Record', () => {
      const r = commonSchemas.kvJsonString().safeParse('{"a":"1","b":"2"}');
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ a: '1', b: '2' });
    });

    it('returns {} for empty string', () => {
      const r = commonSchemas.kvJsonString().safeParse('');
      if (r.success) expect(r.data).toEqual({});
    });

    it('returns {} for invalid JSON (no throw)', () => {
      const r = commonSchemas.kvJsonString().safeParse('not json');
      if (r.success) expect(r.data).toEqual({});
    });

    it('returns {} for JSON array (not object)', () => {
      const r = commonSchemas.kvJsonString().safeParse('[1,2]');
      if (r.success) expect(r.data).toEqual({});
    });

    it('coerces numeric values to strings', () => {
      const r = commonSchemas.kvJsonString().safeParse('{"port":8080}');
      if (r.success) expect(r.data).toEqual({ port: '8080' });
    });
  });
});
