/**
 * L'inviluppo finito dentro i nodi.
 *
 * Il 2026-08-06 il modello ha consegnato ventisei «nodi» con
 * `defId: "tablesToCreate"` — ventisei volte lo stesso errore di validazione,
 * e il wizard morto. `tablesToCreate` è un campo di primo livello, fratello di
 * `nodes` ed `edges`: il modello lo ha scambiato per un tipo di nodo.
 *
 * La causa era nostra: il prompt lo mostrava dentro un esempio JSON, l'esempio
 * è stato tolto perché faceva scattare la protezione anti-leak del modello, e
 * con lui è sparita l'unica riga che diceva DOVE quel campo vivesse.
 *
 * Il prompt adesso lo dice a parole. Questo modulo non chiede niente a
 * nessuno: ripara.
 *
 * @module services/ai-scaffold/ripara-inviluppo.test
 */

import { describe, expect, it } from 'vitest';

import { riparaInviluppo } from '@/services/ai-scaffold/ripara-inviluppo.js';

const nodo = (id: string, defId: string, config: Record<string, unknown> = {}) => ({
  id,
  defId,
  config,
});

describe('il caso vero', () => {
  it('toglie i finti nodi e lascia quelli veri', () => {
    const esito = riparaInviluppo([
      nodo('cron', 'trigger_cron'),
      nodo('tables_to_create', 'tablesToCreate'),
      nodo('tables_to_create_2', 'tablesToCreate'),
      nodo('purga', 'db_delete'),
    ]);

    expect(esito.tolti).toBe(2);
    expect(esito.nodi.map((n) => n.id)).toEqual(['cron', 'purga']);
  });

  /**
   * Il modello aveva descritto la tabella BENE, solo nel posto sbagliato:
   * buttarla perderebbe un'informazione buona.
   */
  it('salva la tabella che il finto nodo portava con sé', () => {
    const esito = riparaInviluppo([
      nodo('x', 'tablesToCreate', {
        name: 'log',
        columns: [
          { name: 'id', type: 'uuid' },
          { name: 'created_at', type: 'datetime' },
        ],
      }),
    ]);

    expect(esito.tabelleRecuperate).toEqual([
      {
        name: 'log',
        columns: [
          { name: 'id', type: 'uuid' },
          { name: 'created_at', type: 'datetime' },
        ],
      },
    ]);
  });

  /** Ventisei copie dello stesso sbaglio non fanno ventisei tabelle. */
  it('non duplica la stessa tabella ripetuta', () => {
    const uno = nodo('a', 'tablesToCreate', { name: 'log', columns: [{ name: 'id' }] });
    const esito = riparaInviluppo([uno, { ...uno, id: 'b' }, { ...uno, id: 'c' }]);
    expect(esito.tabelleRecuperate).toHaveLength(1);
  });
});

/**
 * Gli ARCHI finiti dentro i nodi.
 *
 * Il 2026-08-16: cinquantasei «nodi» con `defId` come
 * `edge_trigger_cron_community_slack` — i collegamenti messi in `nodes`, ognuno
 * col nome composto da «edge» più i due estremi. Cinquantasei errori di
 * validazione identici, e il wizard morto.
 */
describe('gli archi messi fra i nodi', () => {
  it('li toglie e lascia i nodi veri', () => {
    const esito = riparaInviluppo([
      nodo('cron', 'trigger_cron'),
      nodo('e1', 'edge_trigger_cron_community_slack'),
      nodo('e2', 'edge_community_slack_db_insert'),
      nodo('slack', 'community_slack'),
    ]);
    expect(esito.tolti).toBe(2);
    expect(esito.nodi.map((n) => n.id)).toEqual(['cron', 'slack']);
  });

  it('riconosce anche la forma col trattino', () => {
    expect(riparaInviluppo([nodo('x', 'edge-a-b')]).tolti).toBe(1);
  });

  /** Un nodo vero che comincia per «edge» non esiste, ma il confine dev'essere netto. */
  it('non tocca un defId che contiene «edge» senza cominciarci', () => {
    expect(riparaInviluppo([nodo('x', 'action_edge_case')]).tolti).toBe(0);
  });
});

describe('quello che non deve toccare', () => {
  it('un workflow sano passa intatto', () => {
    const sani = [nodo('cron', 'trigger_cron'), nodo('mail', 'action_send_email')];
    const esito = riparaInviluppo(sani);
    expect(esito.tolti).toBe(0);
    expect(esito.nodi).toEqual(sani);
  });

  /** Un nodo vero che si chiama «nodes» non esiste, ma la difesa è per tipo. */
  it('guarda il defId, non l’id', () => {
    const esito = riparaInviluppo([nodo('nodes', 'trigger_cron')]);
    expect(esito.tolti).toBe(0);
  });

  /** Una tabella senza colonne non si può creare: meglio scartarla. */
  it('non recupera una tabella senza colonne', () => {
    const esito = riparaInviluppo([nodo('x', 'tablesToCreate', { name: 'log' })]);
    expect(esito.tolti).toBe(1);
    expect(esito.tabelleRecuperate).toEqual([]);
  });

  it('non recupera niente da un finto nodo vuoto', () => {
    const esito = riparaInviluppo([nodo('x', 'tablesToCreate')]);
    expect(esito.tolti).toBe(1);
    expect(esito.tabelleRecuperate).toEqual([]);
  });
});
