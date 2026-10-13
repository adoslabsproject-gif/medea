// @vitest-environment happy-dom

/**
 * Un turno di Claude Code visto dal pannello.
 *
 * Il turno dura a lungo e nel frattempo succedono cose: arriva testo, la CLI
 * chiede permessi, l'utente può fermare tutto. Qui si verifica che ognuna
 * arrivi a destinazione — e soprattutto che una domanda «posso?» non resti
 * mai senza risposta, perché la CLI la aspetta ferma.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventoClaudeCode, TurnoClaudeCode } from '../api';
import type { ClaudeCliTurn } from '../claude-cli-turn';

const { api, stato } = vi.hoisted(() => {
  const stato = {
    ascoltatori: [] as ((e: unknown) => void)[],
    turni: [] as unknown[],
  };
  return {
    stato,
    api: {
      turno: vi.fn(),
      permesso: vi.fn(() => Promise.resolve()),
      ferma: vi.fn(() => Promise.resolve(true)),
      ascolta: vi.fn((onEvento: (e: unknown) => void) => {
        stato.ascoltatori.push(onEvento);
        return Promise.resolve(() => {
          stato.ascoltatori = stato.ascoltatori.filter((a) => a !== onEvento);
        });
      }),
    },
  };
});
vi.mock('../api', () => ({ aiApi: { claudeCode: api } }));

import { eseguiTurnoClaudeCode, fermaTurnoClaudeCode } from './esegui';
import { ricordaSessione, scegliCartella, scegliModello, sessioneDi } from './settings';

const FATTO: ClaudeCliTurn = {
  text: 'Fatto.',
  toolCalls: [],
  usage: null,
  sessionId: 'sess-nuova',
};

/** Manda un evento a chi ascolta, come farebbe il backend. */
type SenzaTurno<T> = T extends unknown ? Omit<T, 'turnId'> : never;

function evento(e: SenzaTurno<EventoClaudeCode>, turnId: string) {
  for (const a of [...stato.ascoltatori]) a({ turnId, ...e });
}

/** Un turno che il backend tiene aperto finché il test non lo chiude. */
function turnoAperto() {
  let chiudi!: (t: ClaudeCliTurn) => void;
  let rompi!: (e: Error) => void;
  const richieste: TurnoClaudeCode[] = [];
  api.turno.mockImplementation((r: TurnoClaudeCode) => {
    richieste.push(r);
    return new Promise<ClaudeCliTurn>((ok, ko) => {
      chiudi = ok;
      rompi = ko;
    });
  });
  return {
    richieste,
    chiudi: (t: ClaudeCliTurn = FATTO) => {
      chiudi(t);
    },
    rompi: (messaggio: string) => {
      rompi(new Error(messaggio));
    },
  };
}

const storia = [
  { role: 'user' as const, content: 'Ciao' },
  { role: 'assistant' as const, content: 'Buongiorno' },
  { role: 'user' as const, content: 'Che posta ho?' },
];

function richiesta(extra: Partial<Parameters<typeof eseguiTurnoClaudeCode>[0]> = {}) {
  return {
    conversationId: 'conv-1',
    history: storia,
    systemPrompt: 'Sei Medea.',
    chiediPermesso: vi.fn(() => Promise.resolve(true)),
    ...extra,
  };
}

const unAttimo = () =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

beforeEach(() => {
  localStorage.clear();
  stato.ascoltatori = [];
  api.turno.mockReset();
  api.permesso.mockClear();
  api.ferma.mockClear();
  api.ascolta.mockClear();
});

describe('cosa si manda alla CLI', () => {
  it('alla prima volta tutta la conversazione, con modello e cartella scelti', async () => {
    scegliModello('opus');
    scegliCartella('/progetto');
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(richiesta());
    await unAttimo();
    t.chiudi();
    await esito;

    expect(t.richieste[0]).toMatchObject({
      prompt: 'Utente: Ciao\n\nAssistente: Buongiorno\n\nUtente: Che posta ho?',
      systemPrompt: 'Sei Medea.',
      model: 'opus',
      cwd: '/progetto',
      allowTools: true,
    });
    expect(t.richieste[0]?.sessionId).toBeUndefined();
  });

  it('con una sessione da riprendere, solo l’ultimo messaggio', async () => {
    ricordaSessione('conv-1', 'sess-vecchia');
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(richiesta());
    await unAttimo();
    t.chiudi();
    await esito;

    expect(t.richieste[0]).toMatchObject({ prompt: 'Che posta ho?', sessionId: 'sess-vecchia' });
  });

  it('il modello predefinito non si passa: decide Claude Code', async () => {
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(richiesta());
    await unAttimo();
    t.chiudi();
    await esito;

    expect(t.richieste[0]?.model).toBeUndefined();
    expect(t.richieste[0]?.cwd).toBeUndefined();
  });

  it('a turno finito la conversazione ricorda la sua sessione', async () => {
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(richiesta());
    await unAttimo();
    t.chiudi();
    await esito;

    expect(sessioneDi('conv-1')).toBe('sess-nuova');
  });
});

describe('mentre il turno gira', () => {
  it('il testo arriva al pannello man mano, tutto quello scritto finora', async () => {
    const t = turnoAperto();
    const onTesto = vi.fn();
    const esito = eseguiTurnoClaudeCode(richiesta({ onTesto }));
    await unAttimo();
    const id = t.richieste[0]?.turnId ?? '';
    evento({ tipo: 'testo', delta: 'Hai ' }, id);
    evento({ tipo: 'testo', delta: 'tre email.' }, id);
    t.chiudi();
    await esito;

    expect(onTesto).toHaveBeenLastCalledWith('Hai tre email.');
  });

  it('gli eventi di un altro turno non lo riguardano', async () => {
    const t = turnoAperto();
    const onTesto = vi.fn();
    const esito = eseguiTurnoClaudeCode(richiesta({ onTesto }));
    await unAttimo();
    evento({ tipo: 'testo', delta: 'di un altro' }, 'turno-altrui');
    t.chiudi();
    await esito;

    expect(onTesto).not.toHaveBeenCalled();
  });

  it('gli strumenti in uso vengono annunciati col loro nome', async () => {
    const t = turnoAperto();
    const onStrumento = vi.fn();
    const esito = eseguiTurnoClaudeCode(richiesta({ onStrumento }));
    await unAttimo();
    evento(
      { tipo: 'strumento', id: 'a', name: 'Bash', diMedea: false, input: {} },
      t.richieste[0]?.turnId ?? '',
    );
    t.chiudi();
    await esito;

    expect(onStrumento).toHaveBeenCalledWith('Bash');
  });

  it('a turno finito smette di ascoltare', async () => {
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(richiesta());
    await unAttimo();
    expect(stato.ascoltatori).toHaveLength(1);
    t.chiudi();
    await esito;
    expect(stato.ascoltatori).toHaveLength(0);
  });
});

describe('i permessi', () => {
  const permesso = {
    tipo: 'permesso' as const,
    requestId: 'r1',
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    descrizione: 'Pulizia',
  };

  it('la domanda arriva all’utente con il comando, e il suo sì torna alla CLI', async () => {
    const t = turnoAperto();
    const chiediPermesso = vi.fn(() => Promise.resolve(true));
    const esito = eseguiTurnoClaudeCode(richiesta({ chiediPermesso }));
    await unAttimo();
    const id = t.richieste[0]?.turnId ?? '';
    evento(permesso, id);
    await unAttimo();

    expect(chiediPermesso).toHaveBeenCalledWith(
      { id: 'r1', name: 'Bash', args: { command: 'rm -rf build' } },
      expect.stringContaining('rm -rf build'),
    );
    expect(api.permesso).toHaveBeenCalledWith({
      turnId: id,
      requestId: 'r1',
      consenti: true,
      input: { command: 'rm -rf build' },
    });
    t.chiudi();
    await esito;
  });

  it('il no torna alla CLI come no', async () => {
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(
      richiesta({ chiediPermesso: vi.fn(() => Promise.resolve(false)) }),
    );
    await unAttimo();
    evento(permesso, t.richieste[0]?.turnId ?? '');
    await unAttimo();

    expect(api.permesso).toHaveBeenCalledWith(expect.objectContaining({ consenti: false }));
    t.chiudi();
    await esito;
  });

  /**
   * La CLI aspetta ferma la risposta. Se chiedere all'utente fallisse e non
   * si rispondesse niente, il turno resterebbe appeso per sempre.
   */
  it('se la domanda all’utente fallisce, la CLI riceve comunque un no', async () => {
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(
      richiesta({ chiediPermesso: vi.fn(() => Promise.reject(new Error('pannello chiuso'))) }),
    );
    await unAttimo();
    evento(permesso, t.richieste[0]?.turnId ?? '');
    await unAttimo();

    expect(api.permesso).toHaveBeenCalledWith(expect.objectContaining({ consenti: false }));
    t.chiudi();
    await esito;
  });
});

describe('quando la sessione non c’è più', () => {
  it('ricomincia da capo, mandando tutta la conversazione', async () => {
    ricordaSessione('conv-1', 'sess-sparita');
    api.turno
      .mockRejectedValueOnce(
        new Error('errore (error_during_execution). No conversation found with session ID: x'),
      )
      .mockResolvedValueOnce(FATTO);

    const turno = await eseguiTurnoClaudeCode(richiesta());

    expect(turno.text).toBe('Fatto.');
    expect(api.turno).toHaveBeenCalledTimes(2);
    const seconda = api.turno.mock.calls[1]?.[0] as TurnoClaudeCode;
    expect(seconda.sessionId).toBeUndefined();
    expect(seconda.prompt).toContain('Utente: Ciao');
    expect(sessioneDi('conv-1')).toBe('sess-nuova');
  });

  /**
   * Un errore qualunque a metà turno non si ritenta: gli strumenti possono
   * avere già agito, e rifare il turno li farebbe agire due volte.
   */
  it('un altro errore non si ritenta, e la sessione resta', async () => {
    ricordaSessione('conv-1', 'sess-buona');
    api.turno.mockRejectedValueOnce(new Error('Limite di utilizzo raggiunto'));

    await expect(eseguiTurnoClaudeCode(richiesta())).rejects.toThrow('Limite di utilizzo');
    expect(api.turno).toHaveBeenCalledTimes(1);
    expect(sessioneDi('conv-1')).toBe('sess-buona');
  });
});

describe('fermare', () => {
  it('ferma il turno in corso, per nome', async () => {
    const t = turnoAperto();
    const esito = eseguiTurnoClaudeCode(richiesta());
    await unAttimo();
    await fermaTurnoClaudeCode();

    expect(api.ferma).toHaveBeenCalledWith(t.richieste[0]?.turnId);
    t.rompi('Interrotto.');
    await expect(esito).rejects.toThrow('Interrotto.');
  });

  it('senza un turno in corso non fa niente', async () => {
    await fermaTurnoClaudeCode();
    expect(api.ferma).not.toHaveBeenCalled();
  });
});
