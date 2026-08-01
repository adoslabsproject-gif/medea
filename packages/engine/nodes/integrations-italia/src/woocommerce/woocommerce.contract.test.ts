/**
 * Contract test ANTI-DRIFT — italia_woocommerce.
 *
 * Storia (review nodi): il commento header prometteva "OAuth1 / Basic Auth" ma
 * l'executor NON implementa OAuth1 (fallback HTTP = query-param auth). Corretto il
 * commento. Questo guard verifica che la description utente resti onesta (Basic Auth,
 * niente OAuth1) e che ogni action/resource dichiarata esista nell'enum reale.
 */
import { describe, it, expect } from 'vitest';
import { woocommerceNode } from './index.js';

const def = woocommerceNode.def;
const description = def.description ?? '';

function options(key: string): readonly string[] {
  const f = def.configFields?.find((x) => x.key === key);
  return f?.type === 'select' ? f.options : [];
}

describe('italia_woocommerce — contract (anti-drift)', () => {
  it('🚨 la description NON promette OAuth1 (auth reale = Basic / query-param)', () => {
    expect(description).not.toMatch(/OAuth\s*1/i);
    expect(description).toMatch(/consumer_key/i);
  });

  it('🚨 l\'enum action è quello reale (incl. batch citato in description)', () => {
    expect([...options('action')].sort()).toEqual(['batch', 'create', 'delete', 'get', 'list', 'update']);
    // "batch endpoint" è l'unica action nominata esplicitamente nella description.
    expect(description.toLowerCase()).toContain('batch');
  });

  it('le resource citate nella description esistono nell\'enum', () => {
    const resources = options('resource');
    for (const r of ['products', 'orders', 'customers', 'coupons']) {
      expect(resources).toContain(r);
    }
  });
});
