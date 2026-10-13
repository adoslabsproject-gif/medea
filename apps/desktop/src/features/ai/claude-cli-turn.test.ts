/**
 * Cosa fa Medea di un turno eseguito dalla CLI in abbonamento.
 *
 * Con gli altri provider il ciclo degli strumenti è di Medea: li esegue lei,
 * e sa quando chiedere una conferma o mostrare una bozza. Con la CLI il ciclo
 * è della CLI, e Medea riceve il turno a cose fatte. Finché ne teneva solo il
 * testo, l'assistente diceva «ti ho preparato la bozza» e la bozza non
 * compariva da nessuna parte.
 */

import { describe, expect, it } from 'vitest';

import {
  leggiTurnoCli,
  promptPerCli,
  ultimoMessaggio,
  type ClaudeCliTurn,
} from './claude-cli-turn';
import type { ToolDescriptor } from './tools';

const ADESSO = '2026-10-11T09:00:00.000Z';

function strumento(name: string, kind: ToolDescriptor['kind']): ToolDescriptor {
  return { name, kind, description: name, params: {}, example: {} };
}

const REGISTRO = [
  strumento('email_recent', 'read'),
  strumento('note_add', 'write'),
  strumento('email_draft', 'proposal'),
  strumento('customer_update', 'sensitive'),
];

type Chiamata = ClaudeCliTurn['toolCalls'][number];

/** Un turno di prova. Salvo diversa indicazione, gli strumenti sono di Medea. */
function turno(toolCalls: (Omit<Chiamata, 'diMedea'> & { diMedea?: boolean })[]): ClaudeCliTurn {
  return {
    text: 'Fatto.',
    toolCalls: toolCalls.map((c) => ({ diMedea: true, ...c })),
    usage: null,
    sessionId: null,
  };
}

describe('leggiTurnoCli — strumenti già eseguiti dalla CLI', () => {
  it('una lettura compare fra gli eseguiti con i suoi dati', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 't1',
          name: 'email_recent',
          arguments: { count: 3 },
          output: '{"messages":[{"subject":"Ciao"}]}',
          isError: false,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti).toHaveLength(1);
    expect(letto.eseguiti[0]).toMatchObject({
      call: { id: 't1', name: 'email_recent', args: { count: 3 } },
      result: { messages: [{ subject: 'Ciao' }] },
      error: null,
      startedAt: ADESSO,
    });
  });

  it('un risultato a parole resta testo', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 't1',
          name: 'note_add',
          arguments: { text: 'x' },
          output: 'Appunto salvato.',
          isError: false,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti[0]?.result).toBe('Appunto salvato.');
  });

  it('uno strumento fallito porta l’errore, non un risultato', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 't1',
          name: 'email_recent',
          arguments: {},
          output: 'Errore: casella non trovata',
          isError: true,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti[0]).toMatchObject({
      result: null,
      error: 'Errore: casella non trovata',
    });
  });

  it('uno strumento senza risposta è un errore dichiarato', () => {
    const letto = leggiTurnoCli(
      turno([{ id: 't1', name: 'email_recent', arguments: {}, output: null, isError: false }]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti[0]?.result).toBeNull();
    expect(letto.eseguiti[0]?.error).toMatch(/nessuna risposta/u);
  });

  it('argomenti che non sono un oggetto diventano un oggetto vuoto', () => {
    const letto = leggiTurnoCli(
      turno([{ id: 't1', name: 'email_recent', arguments: null, output: '{}', isError: false }]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti[0]?.call.args).toEqual({});
  });
});

describe('leggiTurnoCli — quello che spetta all’utente', () => {
  /**
   * Il server non esegue uno strumento sensibile: lo annuncia. Se Medea lo
   * contasse fra gli eseguiti, l'utente vedrebbe «cliente aggiornato» per una
   * modifica mai avvenuta — e nessuno gliela chiederebbe più.
   */
  it('uno strumento sensibile va confermato, non è fra gli eseguiti', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 't1',
          name: 'customer_update',
          arguments: { id: 7, phone: '02 1234' },
          output: 'Questa azione modifica dati e NON è stata eseguita.',
          isError: false,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti).toEqual([]);
    expect(letto.daConfermare).toEqual([
      { id: 't1', name: 'customer_update', args: { id: 7, phone: '02 1234' } },
    ]);
  });

  /**
   * Al modello la bozza torna come una riga di riepilogo. La scheda si
   * ricostruisce rieseguendo lo strumento qui, che non invia e non salva.
   */
  it('una bozza va preparata da Medea per poterla mostrare', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 't1',
          name: 'email_draft',
          arguments: { to: ['a@example.com'] },
          output: 'Bozza pronta. La scheda è mostrata all’utente.',
          isError: false,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti).toEqual([]);
    expect(letto.daPreparare).toEqual([
      { id: 't1', name: 'email_draft', args: { to: ['a@example.com'] } },
    ]);
  });

  it('una bozza fallita non si prepara: resta l’errore da mostrare', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 't1',
          name: 'email_draft',
          arguments: {},
          output: "Errore: 'to' è obbligatorio",
          isError: true,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.daPreparare).toEqual([]);
    expect(letto.eseguiti[0]?.error).toContain('obbligatorio');
  });

  it('l’ordine delle chiamate è quello in cui la CLI le ha fatte', () => {
    const letto = leggiTurnoCli(
      turno([
        { id: 'a', name: 'email_recent', arguments: {}, output: '{}', isError: false },
        { id: 'b', name: 'note_add', arguments: {}, output: 'ok', isError: false },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti.map((r) => r.call.id)).toEqual(['a', 'b']);
  });

  it('uno strumento che Medea non conosce si mostra com’è, senza eseguirlo', () => {
    const letto = leggiTurnoCli(
      turno([{ id: 't1', name: 'sconosciuto', arguments: {}, output: 'boh', isError: false }]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti).toHaveLength(1);
    expect(letto.daConfermare).toEqual([]);
    expect(letto.daPreparare).toEqual([]);
  });
});

describe('leggiTurnoCli — gli strumenti di Claude Code', () => {
  /**
   * Un comando di shell o una modifica di file li ha già eseguiti la CLI,
   * dopo aver chiesto il permesso nel pannello. Medea li mostra e basta.
   */
  it('si mostrano com’erano, con il loro esito', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 'b1',
          name: 'Bash',
          diMedea: false,
          arguments: { command: 'ls' },
          output: 'a.txt\nb.txt',
          isError: false,
        },
        {
          id: 'b2',
          name: 'Write',
          diMedea: false,
          arguments: { file_path: '/x' },
          output: "L'utente ha negato il permesso.",
          isError: true,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.eseguiti.map((r) => r.call.name)).toEqual(['Bash', 'Write']);
    expect(letto.eseguiti[0]?.result).toBe('a.txt\nb.txt');
    expect(letto.eseguiti[1]?.error).toContain('negato');
  });

  /**
   * Il nome non basta a dire di chi è uno strumento: un plugin dell'utente
   * può chiamare il suo `customer_update`. Rieseguirlo come se fosse quello
   * di Medea modificherebbe un cliente che nessuno ha chiesto di toccare.
   */
  it('uno strumento altrui con il nome di uno di Medea non viene trattato come suo', () => {
    const letto = leggiTurnoCli(
      turno([
        {
          id: 'x1',
          name: 'customer_update',
          diMedea: false,
          arguments: { id: 7 },
          output: 'fatto altrove',
          isError: false,
        },
        {
          id: 'x2',
          name: 'email_draft',
          diMedea: false,
          arguments: {},
          output: 'bozza altrui',
          isError: false,
        },
      ]),
      REGISTRO,
      ADESSO,
    );

    expect(letto.daConfermare).toEqual([]);
    expect(letto.daPreparare).toEqual([]);
    expect(letto.eseguiti).toHaveLength(2);
  });
});

describe('ultimoMessaggio — cosa si manda a una sessione ripresa', () => {
  it('è l’ultimo messaggio dell’utente, senza niente davanti', () => {
    expect(
      ultimoMessaggio([
        { role: 'user', content: 'Ciao' },
        { role: 'assistant', content: 'Buongiorno' },
        { role: 'user', content: '/compact' },
      ]),
    ).toBe('/compact');
  });

  it('senza messaggi dell’utente è vuoto', () => {
    expect(ultimoMessaggio([{ role: 'assistant', content: 'x' }])).toBe('');
  });
});

describe('promptPerCli — la conversazione in un solo testo', () => {
  it('tiene i turni di utente e assistente, in ordine, con chi parla', () => {
    const prompt = promptPerCli([
      { role: 'user', content: 'Ciao' },
      { role: 'assistant', content: 'Buongiorno' },
      { role: 'user', content: 'Che posta ho?' },
    ]);

    expect(prompt).toBe('Utente: Ciao\n\nAssistente: Buongiorno\n\nUtente: Che posta ho?');
  });

  it('lascia fuori i turni degli strumenti e quelli di sistema', () => {
    const prompt = promptPerCli([
      { role: 'system', content: 'regole' },
      { role: 'user', content: 'Ciao' },
      { role: 'tool', content: '{"dati":1}' },
    ]);

    expect(prompt).toBe('Utente: Ciao');
  });
});
