/**
 * Una conferma umana non si pretende dal modello.
 *
 * `db_delete.confirmDelete` è una spunta obbligatoria che dice «so che questo
 * cancella dei dati». Pretenderla in validazione rendeva `db_delete`
 * IMPOSSIBILE da generare: il 2026-08-06 l'obiettivo «ogni primo del mese
 * cancella dalla tabella log le righe più vecchie di novanta giorni» ha
 * bruciato tutti i tentativi lì, con tutto il resto già a posto. Una pulizia
 * periodica è una richiesta ordinaria, e il wizard non poteva soddisfarla in
 * nessun caso.
 *
 * @module services/ai-scaffold/consenso-umano.test
 */

import { describe, expect, it } from 'vitest';

import { eConsensoUmano } from '@/services/ai-scaffold/catalog-validator.js';

describe('quali campi sono un consenso e non una configurazione', () => {
  it('riconosce la conferma di cancellazione', () => {
    expect(eConsensoUmano('confirmDelete')).toBe(true);
  });

  /** La convenzione è il prefisso: chi ne aggiunge un altro lo chiamerà così. */
  it('riconosce le conferme future scritte con la stessa convenzione', () => {
    expect(eConsensoUmano('confirmDropTable')).toBe(true);
    expect(eConsensoUmano('confirm')).toBe(true);
  });

  /** Tutto il resto resta obbligatorio: il modello lo deve compilare. */
  it('non scusa i campi che il modello deve riempire', () => {
    for (const key of ['whereJson', 'table', 'databaseId', 'to', 'subject', 'body']) {
      expect(eConsensoUmano(key)).toBe(false);
    }
  });

  /** Un nome che CONTIENE «confirm» ma non ci comincia non è una conferma. */
  it('non si lascia ingannare da un nome che lo contiene soltanto', () => {
    expect(eConsensoUmano('emailConfirmUrl')).toBe(false);
  });
});
