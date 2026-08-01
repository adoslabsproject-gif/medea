/**
 * Contract test ANTI-DRIFT — italia_register_it_domain.
 *
 * Storia (review nodi): la description dichiarava CAA (assente dall'enum), un "Upsert
 * idempotent" (l'executor fa solo POST/create) e un output { recordId, propagated,
 * ttlSeconds } (ritorna la risposta raw). Risolto: CAA aggiunto all'enum (claim reso
 * vero), upsert/output riconciliati all'onestà (API Register.it non documentata
 * pubblicamente → niente normalizzazione inventata). Questo guard blinda la coerenza.
 */
import { describe, it, expect } from 'vitest';
import { registerItDomain } from './index.js';

const def = registerItDomain.def;
const description = def.description ?? '';
const recordType = def.configFields?.find((f) => f.key === 'recordType');
const types = recordType?.type === 'select' ? recordType.options : [];

describe('italia_register_it_domain — contract (anti-drift)', () => {
  it('🚨 ogni record type citato nella description esiste nell\'enum (CAA incluso)', () => {
    for (const t of ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA']) {
      expect(description, `record "${t}" citato ma non nell'enum`).toContain(t);
      expect(types, `record "${t}" non nell'enum recordType`).toContain(t);
    }
  });

  it('🚨 NON promette "Upsert idempotent" (l\'executor fa solo POST/create)', () => {
    expect(description).not.toMatch(/upsert/i);
    expect(description).not.toMatch(/idempotent/i);
  });

  it('🚨 NON promette un output normalizzato inventato (recordId/propagated/ttlSeconds)', () => {
    expect(description).not.toMatch(/propagated/i);
    expect(description).not.toMatch(/ttlSeconds/i);
  });
});
