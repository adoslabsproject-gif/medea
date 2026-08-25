/**
 * Il database di lavoro nasce UNA volta sola.
 *
 * Il 2026-08-05 alle 15:40:45.915 ne sono nati due, con lo stesso nome, allo
 * stesso millisecondo. La causa era una `await` fra il controllo della cache e
 * la creazione: `StrictMode` monta gli effetti due volte in sviluppo, le due
 * chiamate partivano insieme, nessuna delle due trovava niente, e ognuna
 * creava il suo. Da lì in poi le tabelle stavano in un database e il wizard
 * poteva guardare nell'altro — che risultava vuoto, senza che niente lo
 * segnalasse.
 *
 * Questi test riproducono la concorrenza vera: due chiamate che partono prima
 * che la prima abbia risposto.
 *
 * @module features/workflows/runtime/tables.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  runtimeApi: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

import { runtimeApi } from './client';
import { databaseDelWorkflow, eliminaArchiviDelWorkflow, forgetWorkingDatabase } from './tables';

const MARCATORE = 'medea:workflow:7';
const archivio = (id: string, tables?: { name: string }[]) => ({
  id,
  name: 'x · #7',
  description: `Tabelle del workflow «x». ${MARCATORE}`,
  ...(tables ? { tables } : {}),
});

/** Una risposta che tarda: è nell'attesa che la corsa si consumava. */
function tardando<T>(valore: T, ms = 5): Promise<T> {
  return new Promise((r) => {
    setTimeout(() => {
      r(valore);
    }, ms);
  });
}

describe('databaseDelWorkflow — una volta sola, e uno per workflow', () => {
  beforeEach(() => {
    forgetWorkingDatabase();
    vi.mocked(runtimeApi.get).mockReset();
    vi.mocked(runtimeApi.post).mockReset();
  });

  it('due chiamate insieme creano UN database, non due', async () => {
    vi.mocked(runtimeApi.get).mockImplementation(() => tardando({ databases: [] }));
    vi.mocked(runtimeApi.post).mockImplementation(() =>
      tardando({ database: archivio('nuovo') }),
    );

    // Insieme, non in fila: è la situazione che rompeva.
    const [a, b] = await Promise.all([databaseDelWorkflow(7, 'x'), databaseDelWorkflow(7, 'x')]);

    expect(a).toBe('nuovo');
    expect(b).toBe('nuovo');
    expect(vi.mocked(runtimeApi.post)).toHaveBeenCalledTimes(1);
  });

  it('non ne crea uno se ce n’è già uno', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [archivio('esistente')],
    });

    await expect(databaseDelWorkflow(7, 'x')).resolves.toBe('esistente');
    expect(vi.mocked(runtimeApi.post)).not.toHaveBeenCalled();
  });

  /**
   * I doppioni già nati restano sul disco di chi li ha: la scelta deve essere
   * sempre la stessa, o le tabelle si vedrebbero a giorni alterni.
   */
  it('fra omonimi sceglie quello che ha le tabelle', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [
        archivio('aaa-vuoto', []),
        archivio('zzz-pieno', [{ name: 'inbox' }, { name: 'ordini' }]),
      ],
    });

    await expect(databaseDelWorkflow(7, 'x')).resolves.toBe('zzz-pieno');
  });

  it('a parità di tabelle sceglie sempre lo stesso, non a caso', async () => {
    const elenco = {
      databases: [archivio('bbb', []), archivio('aaa', [])],
    };
    vi.mocked(runtimeApi.get).mockResolvedValue(elenco);

    const primo = await databaseDelWorkflow(7, 'x');
    forgetWorkingDatabase();
    const secondo = await databaseDelWorkflow(7, 'x');

    expect(primo).toBe('aaa');
    expect(secondo).toBe('aaa');
  });

  /** Un errore non deve restare appiccicato: si deve poter riprovare. */
  it('dopo un errore la chiamata successiva riprova', async () => {
    vi.mocked(runtimeApi.get).mockRejectedValueOnce(new Error('runtime giù'));
    await expect(databaseDelWorkflow(7, 'x')).rejects.toThrow('runtime giù');

    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [archivio('tornato')],
    });
    await expect(databaseDelWorkflow(7, 'x')).resolves.toBe('tornato');
  });
});

/**
 * «Ogni workflow le sue tabelle. Workflow con lo stesso nome non devono mai
 * avere le stesse tabelle.»
 *
 * Prima l'archivio era uno solo, condiviso: due workflow che nominavano una
 * tabella `inbox` finivano sulla stessa, e due omonimi erano indistinguibili —
 * non si poteva dire di chi fosse una tabella, quindi non si poteva nemmeno
 * cancellarne una senza rischiare i dati di un altro.
 */
describe('ogni workflow il suo archivio', () => {
  beforeEach(() => {
    forgetWorkingDatabase();
    vi.mocked(runtimeApi.get).mockReset();
    vi.mocked(runtimeApi.post).mockReset();
  });

  it('due workflow con lo STESSO NOME hanno archivi diversi', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({ databases: [] });
    let contatore = 0;
    vi.mocked(runtimeApi.post).mockImplementation(() => {
      contatore += 1;
      return Promise.resolve({ database: { id: `db${String(contatore)}` } });
    });

    const primo = await databaseDelWorkflow(1, 'Riassunto serale');
    const secondo = await databaseDelWorkflow(2, 'Riassunto serale');

    expect(primo).not.toBe(secondo);
    expect(vi.mocked(runtimeApi.post)).toHaveBeenCalledTimes(2);
  });

  /** Il legame è l'id: rinominare il workflow non deve spezzarlo. */
  it('ritrova il suo archivio anche se il workflow è stato rinominato', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [
        {
          id: 'suo',
          name: 'Nome vecchio · #7',
          description: 'Tabelle del workflow «Nome vecchio». medea:workflow:7',
        },
      ],
    });

    await expect(databaseDelWorkflow(7, 'Nome nuovo')).resolves.toBe('suo');
    expect(vi.mocked(runtimeApi.post)).not.toHaveBeenCalled();
  });

  /**
   * L'archivio condiviso nato prima non ha marcatore: non appartiene a
   * nessuno, e nessuna cancellazione di workflow deve portarselo via.
   */
  it('non adotta l’archivio condiviso di prima', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [
        {
          id: 'condiviso',
          name: 'Medea — dati delle automazioni',
          description: 'Le tabelle create dai workflow di Medea.',
          tables: [{ name: 'inbox' }, { name: 'ordini' }],
        },
      ],
    });
    vi.mocked(runtimeApi.post).mockResolvedValue({ database: { id: 'nuovo' } });

    await expect(databaseDelWorkflow(7, 'x')).resolves.toBe('nuovo');
  });

  it('l’archivio di un altro workflow non è il suo', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [
        { id: 'altrui', name: 'x · #99', description: 'Tabelle. medea:workflow:99' },
      ],
    });
    vi.mocked(runtimeApi.post).mockResolvedValue({ database: { id: 'mio' } });

    await expect(databaseDelWorkflow(7, 'x')).resolves.toBe('mio');
  });
});

describe('eliminare gli archivi di un workflow', () => {
  beforeEach(() => {
    forgetWorkingDatabase();
    vi.mocked(runtimeApi.get).mockReset();
    vi.mocked(runtimeApi.delete).mockReset().mockResolvedValue(undefined);
  });

  it('elimina i suoi e SOLO i suoi', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({
      databases: [
        { id: 'suo', name: 'a · #7', description: 'medea:workflow:7' },
        { id: 'altrui', name: 'b · #99', description: 'medea:workflow:99' },
        { id: 'condiviso', name: 'Medea — dati delle automazioni', description: 'senza padrone' },
      ],
    });

    const esito = await eliminaArchiviDelWorkflow(7);

    expect(esito.eliminati).toBe(1);
    expect(vi.mocked(runtimeApi.delete)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtimeApi.delete)).toHaveBeenCalledWith('/db/databases/suo');
  });

  it('un workflow senza archivio non fa danni', async () => {
    vi.mocked(runtimeApi.get).mockResolvedValue({ databases: [] });
    await expect(eliminaArchiviDelWorkflow(7)).resolves.toEqual({ eliminati: 0, problemi: [] });
    expect(vi.mocked(runtimeApi.delete)).not.toHaveBeenCalled();
  });
});
