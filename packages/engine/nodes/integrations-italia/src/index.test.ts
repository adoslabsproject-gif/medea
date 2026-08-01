import { describe, it, expect } from 'vitest';
import { NodeDefSchema } from '@flowforge/core-schema';
import { italianConnectors } from './index.js';

describe('italianConnectors', () => {
  it('every connector validates against NodeDefSchema', () => {
    for (const node of italianConnectors) {
      const result = NodeDefSchema.safeParse(node.def);
      if (!result.success) {
        throw new Error(`${node.def.id} failed: ${result.error.message}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it('all italian connector ids are prefixed with italia_', () => {
    for (const node of italianConnectors) {
      expect(node.def.id.startsWith('italia_')).toBe(true);
    }
  });

  it('vendor coerente con il sistema target (flowforge-italia per native, vendor name per OSS)', () => {
    // I connettori italiani "native" (SDI, PEC, Fatture-in-Cloud, Register.it)
    // dichiarano `flowforge-italia` come vendor (build interno). I connettori
    // di tool third-party OSS (Odoo, WooCommerce, WordPress) usano il nome
    // del tool come vendor — convention enterprise per identificare la
    // provenienza in node palette + per il marketplace community.
    const ALLOWED_VENDORS = new Set(['flowforge-italia', 'odoo', 'woocommerce', 'wordpress']);
    for (const node of italianConnectors) {
      expect(ALLOWED_VENDORS.has(node.def.vendor ?? '')).toBe(true);
    }
  });

  it('ships at least 8 connectors at v0.1', () => {
    expect(italianConnectors.length).toBeGreaterThanOrEqual(8);
  });
});
