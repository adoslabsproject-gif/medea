/**
 * Guardia sulla tassonomia dei nodi — `inferCategory` decide in che categoria
 * finisce ogni nodo del catalogo mostrato al modello. Se l'euristica cambia
 * senza che nessuno se ne accorga, i nodi si spostano di categoria e il
 * catalogo che il modello legge non corrisponde più a quello che l'utente vede.
 *
 * Fino al 2026-08-02 questo test confrontava l'euristica con quella del portal
 * web di provenienza (`apps/portal/scripts/sync-node-defs.mjs`). In Medea quel
 * portal non esiste: il catalogo lo costruisce il desktop. Restano quindi le
 * asserzioni che valgono qui — il contratto fra gli override espliciti e la
 * funzione che li applica, e i rami dell'euristica per sottostringa.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { CATEGORY_LABELS, EXPLICIT_CATEGORY, inferCategory } from './category.js';

describe('tassonomia delle categorie del catalogo', () => {
  it('ogni override esplicito viene davvero applicato da inferCategory', () => {
    const mismatches: string[] = [];
    for (const [id, expected] of Object.entries(EXPLICIT_CATEGORY)) {
      const actual = inferCategory(id, 'action');
      if (actual !== expected) mismatches.push(`${id}: atteso '${expected}', ottenuto '${actual}'`);
    }
    expect(mismatches, mismatches.join('; ')).toEqual([]);
  });

  it('ogni categoria usata negli override è una categoria dichiarata', () => {
    const known = new Set(Object.keys(CATEGORY_LABELS));
    const unknown = [...new Set(Object.values(EXPLICIT_CATEGORY))].filter((c) => !known.has(c));
    expect(unknown, `categorie non dichiarate in CATEGORY_LABELS: ${unknown.join(', ')}`).toEqual(
      [],
    );
  });

  it('gli override non sono vuoti (sanity: la mappa non è stata svuotata)', () => {
    expect(Object.keys(EXPLICIT_CATEGORY).length).toBeGreaterThan(20);
  });

  it('i rami dell euristica per sottostringa restano quelli attesi', () => {
    expect(inferCategory('integration_x', 'action')).toBe('integrations');
    expect(inferCategory('italia_x', 'action')).toBe('italia');
    expect(inferCategory('x_pdf_y', 'action')).toBe('files');
    expect(inferCategory('x_db_y', 'action')).toBe('database');
  });

  it('il tipo trigger vince sulle euristiche per sottostringa', () => {
    expect(inferCategory('qualcosa_di_ignoto', 'trigger')).toBe('triggers');
  });
});
