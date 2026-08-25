/**
 * Guardare nel database invece di indovinare.
 *
 * Il 2026-08-07, alla richiesta «leggi gli articoli della tabella magazzino»,
 * il modello ha risposto `[TOOL_CALLS]read_table{"table_path": "/Users/tu/…"}`.
 * Non stava impazzendo: fra i dieci strumenti che gli davamo non ce n'era
 * nessuno per guardare i dati, e se l'è inventato — puntato a un file sul
 * disco che non esiste.
 *
 * `magazzino` infatti non c'era: le tabelle erano `inbox` e `ordini`.
 *
 * @module features/workflows/scaffold/tools-db.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/client', () => ({
  runtimeApi: { get: vi.fn(), post: vi.fn() },
}));

import { runtimeApi } from '../runtime/client';

import { DB_READ_TOOLS, eseguiStrumentoDb, STRUMENTI_DB } from './tools-db';

const dati = (r: { data: unknown }): Record<string, unknown> =>
  r.data as Record<string, unknown>;

beforeEach(() => {
  vi.mocked(runtimeApi.get).mockReset();
  vi.mocked(runtimeApi.post).mockReset();
});

describe('gli strumenti che offriamo', () => {
  it('sono tre, e dichiarano tutti di non modificare niente', () => {
    expect(DB_READ_TOOLS).toHaveLength(3);
    for (const t of DB_READ_TOOLS) expect(t.description).toContain('Non modifica niente');
  });

  it('l’elenco dei nomi combacia con quelli definiti', () => {
    expect([...STRUMENTI_DB].sort()).toEqual(DB_READ_TOOLS.map((t) => t.name).sort());
  });
});

describe('elenca_tabelle — il caso che li ha fatti nascere', () => {
  it('dice quali tabelle ci sono davvero', async () => {
    vi.mocked(runtimeApi.get).mockImplementation((path: string) =>
      path === '/db/databases'
        ? Promise.resolve({ databases: [{ id: 'db1', name: 'Archivio' }] })
        : Promise.resolve({
            database: {
              id: 'db1',
              name: 'Archivio',
              tables: [{ name: 'inbox' }, { name: 'ordini' }],
            },
          }),
    );

    const out = dati(await eseguiStrumentoDb('elenca_tabelle', {}));
    const archivi = out.archivi as { tabelle: string[] }[];
    expect(archivi[0]?.tabelle).toEqual(['inbox', 'ordini']);
    // La conclusione che conta: se non è qui, non esiste.
    expect(String(out.nota)).toContain('non esiste');
  });

  it('senza tabelle propone di crearne una invece di tacere', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({ databases: [] });
    const out = dati(await eseguiStrumentoDb('elenca_tabelle', {}));
    expect(String(out.nota)).toContain('crearla');
  });

  it('se il motore non risponde lo dice, invece di far finta', async () => {
    vi.mocked(runtimeApi.get).mockRejectedValue(new Error('giù'));
    expect(String(dati(await eseguiStrumentoDb('elenca_tabelle', {})).error)).toContain(
      'non risponde',
    );
  });
});

describe('descrivi_tabella', () => {
  const conTabelle = () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      database: {
        id: 'db1',
        name: 'Archivio',
        tables: [{ name: 'inbox', columns: [{ name: 'id', type: 'text' }, { name: 'letta' }] }],
      },
    });
  };

  it('dà le colonne coi tipi', async () => {
    conTabelle();
    const out = dati(await eseguiStrumentoDb('descrivi_tabella', { databaseId: 'db1', table: 'inbox' }));
    expect(out.colonne).toEqual([
      { nome: 'id', tipo: 'text' },
      { nome: 'letta', tipo: 'text' },
    ]);
  });

  /**
   * Il caso di «magazzino»: la risposta deve dire cosa c'è e cosa fare, non
   * limitarsi a un errore che spinge a cercare altrove.
   */
  it('su una tabella che non esiste elenca quelle vere e dice di proporne la creazione', async () => {
    conTabelle();
    const out = dati(
      await eseguiStrumentoDb('descrivi_tabella', { databaseId: 'db1', table: 'magazzino' }),
    );
    expect(String(out.error)).toContain('non esiste');
    expect(out.tabelleDisponibili).toEqual(['inbox']);
    expect(String(out.nota)).toContain('Non leggerla da un’altra parte');
  });

  it('senza gli argomenti dice quali servono', async () => {
    expect(String(dati(await eseguiStrumentoDb('descrivi_tabella', {})).error)).toContain(
      'elenca_tabelle',
    );
  });
});

describe('leggi_righe', () => {
  it('legge le righe e non supera il tetto', async () => {
    vi.mocked(runtimeApi.post).mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    const out = dati(
      await eseguiStrumentoDb('leggi_righe', { databaseId: 'db1', table: 'inbox', limit: 999 }),
    );
    expect(out.quante).toBe(2);
    const corpo = vi.mocked(runtimeApi.post).mock.calls[0]?.[1] as { limit: number };
    expect(corpo.limit).toBeLessThanOrEqual(50);
  });

  /** Un campo enorme non deve annegare la risposta. */
  it('tronca i valori lunghissimi', async () => {
    vi.mocked(runtimeApi.post).mockResolvedValue({ rows: [{ corpo: 'x'.repeat(5000) }] });
    const out = dati(await eseguiStrumentoDb('leggi_righe', { databaseId: 'db1', table: 'inbox' }));
    const righe = out.righe as { corpo: string }[];
    expect(righe[0]?.corpo).toContain('troncato');
    expect(righe[0]?.corpo.length).toBeLessThan(400);
  });

  it('un errore di lettura si racconta', async () => {
    vi.mocked(runtimeApi.post).mockRejectedValue(new Error('no such table'));
    expect(
      String(dati(await eseguiStrumentoDb('leggi_righe', { databaseId: 'db1', table: 'x' })).error),
    ).toContain('no such table');
  });
});

describe('uno strumento che non c’è', () => {
  it('non finge di averlo eseguito', async () => {
    expect(String(dati(await eseguiStrumentoDb('read_table', {})).error)).toContain('sconosciuto');
  });
});
