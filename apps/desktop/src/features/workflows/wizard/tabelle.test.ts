/**
 * Le tabelle del workflow appena costruito.
 *
 * Il 2026-08-06 il wizard ha prodotto «riassunto_serale», con dentro un
 * `db_insert` sulla tabella `riassunti`. La tabella non è mai nata: si creava
 * solo premendo un avviso nell'editor, e chi importava senza passare di lì
 * aveva un workflow che sarebbe fallito con «no such table» — e in DB Studio
 * niente da gestire, perché niente era stato creato.
 *
 * @module features/workflows/wizard/tabelle.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime', () => ({
  createTables: vi.fn(),
  existingTables: vi.fn(),
  databaseDelWorkflow: vi.fn(),
  missingTables: (
    piano: { name: string }[],
    presenti: string[],
  ): { name: string }[] => {
    const noti = new Set(presenti.map((n) => n.toLowerCase()));
    return piano.filter((t) => !noti.has(t.name));
  },
  planTables: (wf: { nodes: { defId: string; config: Record<string, unknown> }[] }) =>
    wf.nodes
      .filter((n) => n.defId === 'db_insert')
      .map((n) => ({
        name: String(n.config.table),
        columns: [
          { name: 'id', type: 'text' },
          { name: 'date', type: 'text' },
          { name: 'tldr', type: 'text' },
        ],
      })),
}));

import { createTables, databaseDelWorkflow, existingTables } from '../runtime';

import {
  archiviConLePianificate,
  messaggioTabelle,
  pianoArricchito,
  preparaTabelle,
  puntaAllArchivio,
} from './tabelle';

const workflow = {
  nodes: [
    { id: 'db_insert', defId: 'db_insert', config: { table: 'riassunti' } },
  ],
} as never;

describe('pianoArricchito — quali tabelle, e con che tipi', () => {
  it('deduce le tabelle dal workflow anche senza l’elenco del motore', () => {
    const piano = pianoArricchito(workflow, undefined);
    expect(piano.map((t) => t.name)).toEqual(['riassunti']);
  });

  /**
   * Il piano dal workflow di fronte a un'espressione sceglie testo, perché non
   * può sapere altro. Il motore, quando c'è, il tipo lo dichiara: prima quel
   * dato veniva calcolato e buttato via.
   */
  it('prende dal motore i tipi delle colonne che combaciano', () => {
    const piano = pianoArricchito(workflow, [
      { name: 'riassunti', columns: [{ name: 'date', type: 'datetime' }] },
    ] as never);
    const date = piano[0]?.columns.find((c) => c.name === 'date');
    expect(date?.type).toBe('datetime');
  });

  /**
   * Il caso del 2026-08-16, e il difetto peggiore di questo modulo.
   *
   * Un `db_insert` dietro un modulo non ha `rowJson`: scrive quello che gli
   * arriva dal nodo prima. Il piano dedotto dal workflow legge le colonne da
   * `rowJson`, quindi non ne trovava nessuna, e `contatti` è nata con il solo
   * `id` — mentre il modulo raccoglieva nome ed email. Il primo contatto
   * ricevuto sarebbe fallito con «no such column: nome».
   *
   * Le colonne che solo il motore conosce vanno AGGIUNTE, non solo usate per
   * affinare i tipi di quelle che c'erano già.
   */
  it('aggiunge le colonne che solo il motore conosce', () => {
    const piano = pianoArricchito(workflow, [
      {
        name: 'riassunti',
        columns: [
          { name: 'nome', type: 'text' },
          { name: 'email', type: 'text' },
        ],
      },
    ] as never);
    const nomi = piano[0]?.columns.map((c) => c.name);
    expect(nomi).toContain('nome');
    expect(nomi).toContain('email');
    // E non perde quelle che il workflow già nominava.
    expect(nomi).toContain('id');
  });

  it('non duplica una colonna che c’era già', () => {
    const piano = pianoArricchito(workflow, [
      { name: 'riassunti', columns: [{ name: 'id', type: 'text' }] },
    ] as never);
    expect(piano[0]?.columns.filter((c) => c.name === 'id')).toHaveLength(1);
  });

  /** Un tipo che non sappiamo dichiarare farebbe fallire la migrazione. */
  it('ignora un tipo inventato invece di rompere la creazione', () => {
    const piano = pianoArricchito(workflow, [
      { name: 'riassunti', columns: [{ name: 'date', type: 'timestamptz' }] },
    ] as never);
    const date = piano[0]?.columns.find((c) => c.name === 'date');
    expect(date?.type).toBe('text');
  });
});

describe('preparaTabelle — crearle davvero', () => {
  beforeEach(() => {
    vi.mocked(databaseDelWorkflow).mockReset().mockResolvedValue('db1');
    vi.mocked(existingTables).mockReset().mockResolvedValue([]);
    vi.mocked(createTables).mockReset().mockResolvedValue({ created: [], problems: [] });
  });

  it('crea quelle che mancano', async () => {
    vi.mocked(createTables).mockResolvedValue({ created: ['riassunti'], problems: [] });
    const esito = await preparaTabelle(7, 'x', pianoArricchito(workflow, undefined));
    expect(esito.create).toEqual(['riassunti']);
    expect(messaggioTabelle(esito)).toContain('riassunti');
  });

  /** Al secondo giro non è un errore: c'erano già, e non si tocca niente. */
  it('non ricrea quelle che ci sono già', async () => {
    vi.mocked(existingTables).mockResolvedValue(['riassunti']);
    const esito = await preparaTabelle(7, 'x', pianoArricchito(workflow, undefined));
    expect(esito.gia).toEqual(['riassunti']);
    expect(vi.mocked(createTables)).not.toHaveBeenCalled();
    expect(messaggioTabelle(esito)).toBe('');
  });

  /**
   * Un archivio che non risponde non deve impedire di importare un workflow
   * già costruito: si racconta il problema e si va avanti.
   */
  it('un archivio irraggiungibile non solleva', async () => {
    vi.mocked(databaseDelWorkflow).mockRejectedValue(new Error('runtime giù'));
    const esito = await preparaTabelle(7, 'x', pianoArricchito(workflow, undefined));
    expect(esito.create).toEqual([]);
    expect(esito.problemi.join(' ')).toContain('runtime giù');
    expect(messaggioTabelle(esito)).toContain('non create');
  });

  it('senza tabelle da creare non parla con nessuno', async () => {
    const esito = await preparaTabelle(7, 'x', []);
    expect(esito).toEqual({ create: [], gia: [], problemi: [] });
    expect(vi.mocked(databaseDelWorkflow)).not.toHaveBeenCalled();
  });
});

/**
 * Le tabelle che stanno per nascere devono contare come esistenti.
 *
 * Il 2026-08-06 il wizard mostrava, nella STESSA schermata: «Nuove tabelle DB
 * richieste: log — verranno create all'import» e, due righe sotto, «la tabella
 * log non esiste: non puoi attivarlo». Due affermazioni vere e incompatibili.
 * Il motore questo conto lo faceva già; il gate del desktop no.
 */
/**
 * Una tabella che l'utente ha già non si ricrea altrove.
 *
 * Il 2026-08-10, all'obiettivo «inserisce nella tabella ordini», il wizard ha
 * creato una SECONDA `ordini` nell'archivio del workflow — e il nodo ci
 * avrebbe scritto dentro. L'utente avrebbe visto gli ordini arrivare in una
 * tabella e la sua restare ferma.
 *
 * «Ogni workflow le sue tabelle» vale per quelle che il workflow CREA.
 */
describe('non duplicare una tabella che esiste già', () => {
  it('la salta se è in un archivio esistente', () => {
    const piano = pianoArricchito(workflow, undefined, [
      { id: 'condiviso', tables: ['inbox', 'riassunti'] },
    ]);
    expect(piano).toEqual([]);
  });

  it('il confronto non guarda le maiuscole', () => {
    const piano = pianoArricchito(workflow, undefined, [
      { id: 'condiviso', tables: ['RIASSUNTI'] },
    ]);
    expect(piano).toEqual([]);
  });

  it('una tabella davvero nuova resta nel piano', () => {
    const piano = pianoArricchito(workflow, undefined, [
      { id: 'condiviso', tables: ['inbox', 'ordini'] },
    ]);
    expect(piano.map((t) => t.name)).toEqual(['riassunti']);
  });

  it('senza archivi esistenti si comporta come prima', () => {
    expect(pianoArricchito(workflow, undefined).map((t) => t.name)).toEqual(['riassunti']);
  });
});

describe('archiviConLePianificate — il gate non blocca ciò che sta per nascere', () => {
  it('aggiunge le tabelle pianificate agli archivi', () => {
    const out = archiviConLePianificate(
      [{ id: 'db1', tables: ['inbox', 'ordini'] }],
      [{ name: 'log', columns: [{ name: 'id', type: 'text' }] }] as never,
    );
    expect(out[0]?.tables).toContain('log');
    expect(out[0]?.columns?.log).toEqual(['id']);
  });

  it('senza piano non tocca niente', () => {
    const archivi = [{ id: 'db1', tables: ['inbox'] }];
    expect(archiviConLePianificate(archivi, [])).toEqual(archivi);
  });
});

/**
 * I nodi devono cercare le tabelle DOVE sono nate.
 *
 * È la seconda metà di «ogni workflow le sue tabelle». Il modello sceglie un
 * `databaseId` fra quelli che vede — di norma l'archivio condiviso — ma le
 * tabelle nuove nascono nell'archivio del workflow: senza ripuntare i nodi, il
 * primo `db_delete` fallirebbe con «no such table» subito dopo che il wizard
 * aveva annunciato di aver creato quella tabella.
 */
describe('puntaAllArchivio — i nodi seguono le loro tabelle', () => {
  const wf = {
    name: 'Pulizia log',
    nodes: [
      { id: 'cron', defId: 'trigger_cron', x: 0, y: 0, config: {} },
      { id: 'purga', defId: 'db_delete', x: 0, y: 0, config: { databaseId: 'condiviso', table: 'log' } },
      { id: 'leggi', defId: 'db_query', x: 0, y: 0, config: { databaseId: 'condiviso', table: 'inbox' } },
    ],
    edges: [],
  } as never;

  it('ripunta solo i nodi che usano una tabella appena creata', () => {
    const { workflow, ripuntati } = puntaAllArchivio(wf, 'archivio_suo', ['log']);
    expect(ripuntati).toBe(1);
    const nodi = workflow.nodes as { id: string; config: Record<string, unknown> }[];
    expect(nodi.find((n) => n.id === 'purga')?.config.databaseId).toBe('archivio_suo');
    // Chi legge una tabella preesistente resta dov'è: non è affare nostro.
    expect(nodi.find((n) => n.id === 'leggi')?.config.databaseId).toBe('condiviso');
  });

  it('senza tabelle create non tocca niente', () => {
    expect(puntaAllArchivio(wf, 'archivio_suo', [])).toEqual({ workflow: wf, ripuntati: 0 });
  });

  it('non riscrive un nodo che già punta all’archivio giusto', () => {
    const gia = {
      ...(wf as { nodes: { id: string; config: Record<string, unknown> }[] }),
      nodes: [
        { id: 'purga', defId: 'db_delete', x: 0, y: 0, config: { databaseId: 'suo', table: 'log' } },
      ],
    } as never;
    expect(puntaAllArchivio(gia, 'suo', ['log']).ripuntati).toBe(0);
  });
});
