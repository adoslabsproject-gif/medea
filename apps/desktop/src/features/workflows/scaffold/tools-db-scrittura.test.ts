/**
 * Scrivere nel database solo dopo che qualcuno ha detto di sì.
 *
 * Il progetto lo dice a chiare lettere: «ogni mutation richiede conferma
 * esplicita dell'utente». Vale a maggior ragione qui, dove chi decide è un
 * modello dentro una conversazione: fra il capire male una frase e il
 * modificare dei dati non ci deve essere niente di automatico.
 *
 * La metà di questi test verifica che NON si scriva: è la parte che conta.
 *
 * @module features/workflows/scaffold/tools-db-scrittura.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/client', () => ({
  runtimeApi: { get: vi.fn(), post: vi.fn() },
}));

import { runtimeApi } from '../runtime/client';

import {
  DB_WRITE_TOOLS,
  eseguiStrumentoDbScrittura,
  STRUMENTI_DB_SCRITTURA,
} from './tools-db-scrittura';

const dati = (r: { data: unknown }): Record<string, unknown> => r.data as Record<string, unknown>;

/** Chi dice sempre di sì, e chi sempre di no. */
const si = vi.fn((_r: { titolo: string; dettaglio: string }) => Promise.resolve(true));
const no = vi.fn((_r: { titolo: string; dettaglio: string }) => Promise.resolve(false));

const TABELLA = {
  databaseId: 'db1',
  name: 'contatti',
  columns: [
    { name: 'id', type: 'text' },
    { name: 'email', type: 'text' },
  ],
};

beforeEach(() => {
  vi.mocked(runtimeApi.post).mockReset().mockResolvedValue(undefined);
  si.mockClear();
  no.mockClear();
});

describe('senza permesso non si scrive', () => {
  /**
   * Il caso che conta di più: un domani questi strumenti potrebbero girare in
   * un contesto senza interfaccia. Il valore predefinito deve essere «non
   * fare», non «fai in silenzio».
   */
  it('senza un modo per chiedere, si rifiuta', async () => {
    const out = dati(await eseguiStrumentoDbScrittura('crea_tabella', TABELLA));
    expect(String(out.error)).toContain('senza permesso non si modifica niente');
    expect(vi.mocked(runtimeApi.post)).not.toHaveBeenCalled();
  });

  it('se l’utente dice di no, non tocca niente', async () => {
    const out = dati(await eseguiStrumentoDbScrittura('crea_tabella', TABELLA, no));
    expect(out.rifiutato).toBe(true);
    expect(vi.mocked(runtimeApi.post)).not.toHaveBeenCalled();
  });

  /** E il modello deve raccontarlo, non riprovare in loop. */
  it('il rifiuto dice al modello di non insistere', async () => {
    const out = dati(await eseguiStrumentoDbScrittura('crea_tabella', TABELLA, no));
    expect(String(out.error)).toContain('Non insistere');
  });

  it('vale anche per la scrittura di righe', async () => {
    const args = { databaseId: 'db1', table: 'contatti', rows: [{ email: 'a@b.it' }] };
    expect(dati(await eseguiStrumentoDbScrittura('scrivi_righe', args)).error).toBeDefined();
    expect(dati(await eseguiStrumentoDbScrittura('scrivi_righe', args, no)).rifiutato).toBe(true);
    expect(vi.mocked(runtimeApi.post)).not.toHaveBeenCalled();
  });
});

describe('la domanda dev’essere valutabile', () => {
  /** «Procedi?» non si può valutare; «crea la tabella contatti con id ed email» sì. */
  it('creando una tabella nomina le colonne', async () => {
    await eseguiStrumentoDbScrittura('crea_tabella', TABELLA, si);
    const richiesta = si.mock.calls[0]?.[0];
    expect(richiesta?.titolo).toContain('contatti');
    expect(richiesta?.dettaglio).toContain('email');
  });

  it('scrivendo righe dice quante e quali colonne', async () => {
    await eseguiStrumentoDbScrittura(
      'scrivi_righe',
      { databaseId: 'db1', table: 'contatti', rows: [{ email: 'a@b.it' }, { email: 'c@d.it' }] },
      si,
    );
    const richiesta = si.mock.calls[0]?.[0];
    expect(richiesta?.titolo).toContain('2 righe');
    expect(richiesta?.dettaglio).toContain('email');
  });
});

describe('col permesso, fa il lavoro', () => {
  it('crea la tabella e mette la chiave sull’id', async () => {
    const out = dati(await eseguiStrumentoDbScrittura('crea_tabella', TABELLA, si));
    expect(out.creata).toBe('contatti');
    const corpo = vi.mocked(runtimeApi.post).mock.calls[0]?.[1] as {
      actions: { table: { columns: { name: string; constraints: { primaryKey?: boolean } }[] } }[];
    };
    const id = corpo.actions[0]?.table.columns.find((c) => c.name === 'id');
    expect(id?.constraints.primaryKey).toBe(true);
  });

  /** Una riga che fallisce non ferma le altre. */
  it('scrive quelle che può e dice quali no', async () => {
    vi.mocked(runtimeApi.post)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no such column: pippo'));
    const out = dati(
      await eseguiStrumentoDbScrittura(
        'scrivi_righe',
        { databaseId: 'db1', table: 'contatti', rows: [{ email: 'a@b.it' }, { pippo: 1 }] },
        si,
      ),
    );
    expect(out.scritte).toBe(1);
    expect(String((out.problemi as string[])[0])).toContain('no such column');
  });
});

describe('quello che rifiuta prima ancora di chiedere', () => {
  it('un nome di tabella non valido', async () => {
    const out = dati(
      await eseguiStrumentoDbScrittura('crea_tabella', { ...TABELLA, name: '9 tabella!' }, si),
    );
    expect(String(out.error)).toContain('non è un nome valido');
    expect(si).not.toHaveBeenCalled();
  });

  it('una tabella senza colonne', async () => {
    const out = dati(
      await eseguiStrumentoDbScrittura('crea_tabella', { ...TABELLA, columns: [] }, si),
    );
    expect(String(out.error)).toContain('almeno una colonna');
    expect(si).not.toHaveBeenCalled();
  });

  it('troppe righe in una volta', async () => {
    const troppe = Array.from({ length: 201 }, () => ({ email: 'x@y.it' }));
    const out = dati(
      await eseguiStrumentoDbScrittura(
        'scrivi_righe',
        { databaseId: 'db1', table: 'contatti', rows: troppe },
        si,
      ),
    );
    expect(String(out.error)).toContain('massimo è 200');
    expect(si).not.toHaveBeenCalled();
  });
});

describe('gli strumenti dichiarati', () => {
  it('dicono tutti che modificano, e che serve la conferma', () => {
    expect(DB_WRITE_TOOLS).toHaveLength(2);
    for (const t of DB_WRITE_TOOLS) {
      expect(t.description).toContain('MODIFICA');
      expect(t.description).toContain('conferma');
    }
  });

  it('l’elenco dei nomi combacia', () => {
    expect([...STRUMENTI_DB_SCRITTURA].sort()).toEqual(DB_WRITE_TOOLS.map((t) => t.name).sort());
  });
});
