import { describe, it, expect } from 'vitest';
import { buildAuthHeaders } from './auth-headers.js';

describe('buildAuthHeaders', () => {
  describe('none', () => {
    it('returns empty when mode=none', () => {
      expect(buildAuthHeaders({ authMode: 'none' })).toEqual({});
    });

    it('returns empty when mode is invalid/unknown', () => {
      expect(buildAuthHeaders({ authMode: 'weird' })).toEqual({});
    });

    it('returns empty when authMode missing (default none)', () => {
      expect(buildAuthHeaders({})).toEqual({});
    });
  });

  describe('basic', () => {
    it('encodes user:pass in base64', () => {
      const r = buildAuthHeaders({ authMode: 'basic', basicUser: 'alice', basicPass: 's3cr3t' });
      expect(r.Authorization).toBe(`Basic ${Buffer.from('alice:s3cr3t').toString('base64')}`);
    });

    it('handles empty user/pass (still encodes empty values)', () => {
      const r = buildAuthHeaders({ authMode: 'basic' });
      expect(r.Authorization).toBe(`Basic ${Buffer.from(':').toString('base64')}`);
    });

    it('stringifies non-string values', () => {
      const r = buildAuthHeaders({ authMode: 'basic', basicUser: 42, basicPass: true });
      expect(r.Authorization).toBe(`Basic ${Buffer.from('42:true').toString('base64')}`);
    });
  });

  describe('bearer', () => {
    it('prefixes token with "Bearer "', () => {
      const r = buildAuthHeaders({ authMode: 'bearer', bearerToken: 'eyJ...' });
      expect(r.Authorization).toBe('Bearer eyJ...');
    });

    it('returns empty if token empty (no Bearer <empty>)', () => {
      expect(buildAuthHeaders({ authMode: 'bearer', bearerToken: '' })).toEqual({});
      expect(buildAuthHeaders({ authMode: 'bearer' })).toEqual({});
    });
  });

  describe('apikey-header', () => {
    it('default header name X-API-Key', () => {
      const r = buildAuthHeaders({ authMode: 'apikey-header', apiKeyValue: 'k123' });
      expect(r['X-API-Key']).toBe('k123');
    });

    it('honors custom header name', () => {
      const r = buildAuthHeaders({ authMode: 'apikey-header', apiKeyHeaderName: 'X-Token', apiKeyValue: 'k123' });
      expect(r['X-Token']).toBe('k123');
    });

    it('returns empty when value missing', () => {
      expect(buildAuthHeaders({ authMode: 'apikey-header' })).toEqual({});
    });
  });

  describe('custom', () => {
    it('default name "Authorization"', () => {
      const r = buildAuthHeaders({ authMode: 'custom', customAuthHeaderValue: 'X-token foo' });
      expect(r.Authorization).toBe('X-token foo');
    });

    it('honors custom header name', () => {
      const r = buildAuthHeaders({ authMode: 'custom', customAuthHeaderName: 'X-Sig', customAuthHeaderValue: 'abc' });
      expect(r['X-Sig']).toBe('abc');
    });

    it('returns empty when value missing', () => {
      expect(buildAuthHeaders({ authMode: 'custom' })).toEqual({});
    });
  });
});
