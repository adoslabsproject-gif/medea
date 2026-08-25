/**
 * `action_contact_lookup` — definizione e regole di configurazione.
 *
 * È il nodo che rende esprimibile «solo se il mittente è in rubrica»: una
 * condizione che le richieste contengono di continuo e che fino al 2026-08-05
 * i workflow generati ignoravano in silenzio, perché non c'era modo di
 * consultare i contatti e nessun controllo lo segnalava.
 */

import { describe, expect, it } from 'vitest';

import { contactLookupNode, contactLookupNodeDef, ContactLookupConfigSchema } from './index.js';

describe('contactLookupNodeDef — contratto col catalogo', () => {
  it('è un nodo azione con l’id atteso', () => {
    expect(contactLookupNodeDef.id).toBe('action_contact_lookup');
    expect(contactLookupNodeDef.type).toBe('action');
  });

  it('non porta un executor: quello vero è lato server', () => {
    expect(contactLookupNode.executor).toBeUndefined();
  });

  /**
   * Il campo va riempito con l'indirizzo del messaggio appena arrivato, e
   * l'aiuto deve dirlo: è l'unico modo in cui questo nodo serve a qualcosa
   * dietro a un trigger email.
   */
  it('spiega come prendere il mittente dal trigger', () => {
    const email = (contactLookupNodeDef.configFields ?? []).find((f) => f.key === 'email');
    expect(email?.help).toContain('$node');
  });

  /** Nessun campo che scriva: la rubrica non si tocca da un workflow. */
  it('non offre nessun campo che modifichi la rubrica', () => {
    const chiavi = (contactLookupNodeDef.configFields ?? []).map((f) => f.key);
    for (const scrittura of ['create', 'update', 'delete', 'upsert', 'write']) {
      expect(chiavi.some((k) => k.toLowerCase().includes(scrittura))).toBe(false);
    }
  });
});

describe('ContactLookupConfigSchema — quello che si rifiuta di fare', () => {
  it('accetta la ricerca per indirizzo', () => {
    const r = ContactLookupConfigSchema.safeParse({ email: '{{$node.arrivo.json.from}}' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.requireFound).toBe(false);
      expect(r.data.limit).toBe(10);
    }
  });

  it('accetta la ricerca libera', () => {
    expect(ContactLookupConfigSchema.safeParse({ query: '@acme.it' }).success).toBe(true);
  });

  /**
   * Senza criterio il nodo restituirebbe la rubrica intera: non è mai quello
   * che si voleva, ed è una configurazione lasciata a metà — meglio dirlo.
   */
  it('rifiuta una configurazione senza nessun criterio', () => {
    expect(ContactLookupConfigSchema.safeParse({}).success).toBe(false);
  });

  /** Cliente **e** fornitore insieme lascia fuori quasi tutti. */
  it('rifiuta i due filtri accesi insieme', () => {
    const r = ContactLookupConfigSchema.safeParse({
      query: 'rossi',
      onlyClients: true,
      onlySuppliers: true,
    });
    expect(r.success).toBe(false);
  });

  it('accetta un filtro alla volta', () => {
    expect(
      ContactLookupConfigSchema.safeParse({ query: 'rossi', onlyClients: 'true' }).success,
    ).toBe(true);
    expect(
      ContactLookupConfigSchema.safeParse({ query: 'rossi', onlySuppliers: 'true' }).success,
    ).toBe(true);
  });

  it('legge spunte e numeri come li manda il modulo', () => {
    const r = ContactLookupConfigSchema.safeParse({
      query: 'x',
      requireFound: 'false',
      limit: '25',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.requireFound).toBe(false);
      expect(r.data.limit).toBe(25);
    }
  });
});
