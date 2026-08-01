import { describe, expect, it } from 'vitest';

import type { NodeDef } from '../types';

import { ACTION_KEY, currentAction, fieldsFor, groupActions, hasActions } from './node-actions';

const telegram: NodeDef = {
  defId: 'community_telegram',
  type: 'action',
  label: 'Telegram',
  configFields: [{ key: 'token', type: 'text', required: true }],
  actions: [
    {
      id: 'send_message',
      label: 'Manda un messaggio',
      category: 'Messaggi',
      configFields: [{ key: 'chatId', type: 'text' }],
    },
    {
      id: 'send_photo',
      label: 'Manda una foto',
      category: 'Messaggi',
      configFields: [{ key: 'url', type: 'text' }],
    },
    { id: 'get_updates', label: 'Leggi gli aggiornamenti', category: 'Lettura' },
    { id: 'sciolta', label: 'Senza gruppo' },
  ],
};

const semplice: NodeDef = { defId: 'action_http', type: 'action', label: 'HTTP' };

describe('i nodi con più operazioni', () => {
  it('riconosce chi ne ha e chi no', () => {
    expect(hasActions(telegram)).toBe(true);
    expect(hasActions(semplice)).toBe(false);
    expect(hasActions(undefined)).toBe(false);
  });

  it('senza una scelta parte dalla prima', () => {
    // Non sceglierne nessuna vorrebbe dire mostrare un pannello vuoto.
    expect(currentAction(telegram, {})?.id).toBe('send_message');
  });

  it('rispetta quella scelta', () => {
    expect(currentAction(telegram, { [ACTION_KEY]: 'send_photo' })?.id).toBe('send_photo');
  });

  it('se la scelta non esiste più, torna alla prima invece di sparire', () => {
    // Capita aggiornando un pacchetto che ha tolto un'operazione: il workflow
    // salvato la nomina ancora.
    expect(currentAction(telegram, { [ACTION_KEY]: 'operazione_sparita' })?.id).toBe(
      'send_message',
    );
  });
});

describe('i campi da compilare', () => {
  it('sono quelli del nodo più quelli dell’operazione scelta', () => {
    const chiavi = fieldsFor(telegram, { [ACTION_KEY]: 'send_photo' }).map((f) => f.key);
    expect(chiavi).toEqual(['token', 'url']);
  });

  it('prima i condivisi, poi quelli dell’operazione', () => {
    // Un token vale per tutte le operazioni: chiederlo dopo il campo
    // specifico sarebbe l'ordine sbagliato.
    const chiavi = fieldsFor(telegram, {}).map((f) => f.key);
    expect(chiavi[0]).toBe('token');
  });

  it('per un nodo normale sono soltanto i suoi', () => {
    expect(fieldsFor(semplice, {})).toEqual([]);
  });
});

describe('l’elenco delle operazioni', () => {
  it('raggruppa per categoria', () => {
    const gruppi = groupActions(telegram.actions ?? []);
    expect(gruppi.map((g) => g.label)).toEqual(['Lettura', 'Messaggi', '']);
  });

  it('tiene in fondo quelle senza gruppo', () => {
    // Un pacchetto che dichiara le categorie a metà non deve spezzare
    // l'elenco con una voce sciolta in mezzo.
    const gruppi = groupActions(telegram.actions ?? []);
    expect(gruppi[gruppi.length - 1]?.label).toBe('');
  });

  it('cerca anche nella descrizione, non solo nel nome', () => {
    const con: NodeDef['actions'] = [
      { id: 'a', label: 'Alfa', description: 'manda una fattura' },
      { id: 'b', label: 'Beta' },
    ];
    const gruppi = groupActions(con, 'fattura');
    expect(gruppi.flatMap((g) => g.actions).map((a) => a.id)).toEqual(['a']);
  });

  it('quando non trova niente restituisce niente, non tutto', () => {
    expect(groupActions(telegram.actions ?? [], 'zzz')).toEqual([]);
  });
});
