import { describe, expect, it } from 'vitest';

import { checkCampiObbligatori } from './rules-campi';
import type { QualityGateInput, QualityNodeDef } from './types';

const DEFS = new Map<string, QualityNodeDef>([
  [
    'trigger_imap',
    {
      configFields: [
        { key: 'accountId', label: 'la casella', required: true },
        { key: 'folder', label: 'la cartella', required: true },
        { key: 'note', label: 'una nota', required: false },
      ],
    },
  ],
  [
    'action_send_email',
    {
      configFields: [
        { key: 'to', label: 'il destinatario', required: true },
        { key: 'subject', label: "l'oggetto", required: false },
      ],
    },
  ],
]);

function input(nodes: QualityGateInput['nodes']): QualityGateInput {
  return { nodes, edges: [], defs: DEFS };
}

describe('i campi che un nodo pretende per funzionare', () => {
  it('🚨 un trigger senza i suoi dati è un problema critico', () => {
    // Il caso vero del 2026-08-04: il verdetto diceva «tutto a posto» su un
    // workflow il cui trigger non sapeva nemmeno quale casella guardare.
    const problemi = checkCampiObbligatori(
      input([{ id: 'trigger_imap', defId: 'trigger_imap', config: {} }]),
    );
    expect(problemi).toHaveLength(1);
    expect(problemi[0]?.severity).toBe('critical');
    expect(problemi[0]?.message).toContain('la casella');
    expect(problemi[0]?.message).toContain('la cartella');
  });

  it('un nodo completo non viene segnalato', () => {
    const problemi = checkCampiObbligatori(
      input([
        {
          id: 'trigger_imap',
          defId: 'trigger_imap',
          config: { accountId: 'acc-1', folder: 'INBOX' },
        },
      ]),
    );
    expect(problemi).toEqual([]);
  });

  it('🚨 un campo riempito di spazi conta come vuoto', () => {
    // «Compilato» per il compilatore, vuoto per chi lo deve usare.
    const problemi = checkCampiObbligatori(
      input([{ id: 'invio', defId: 'action_send_email', config: { to: '   ' } }]),
    );
    expect(problemi).toHaveLength(1);
  });

  it('su un’azione è grave ma non critico: il flusso almeno comincia', () => {
    const problemi = checkCampiObbligatori(
      input([{ id: 'invio', defId: 'action_send_email', config: {} }]),
    );
    expect(problemi[0]?.severity).toBe('medium');
  });

  it('i campi facoltativi non si pretendono', () => {
    const problemi = checkCampiObbligatori(
      input([
        {
          id: 'trigger_imap',
          defId: 'trigger_imap',
          config: { accountId: 'a', folder: 'INBOX' },
        },
      ]),
    );
    expect(problemi).toEqual([]);
  });

  it('di un nodo sconosciuto non si inventa nessun obbligo', () => {
    const problemi = checkCampiObbligatori(
      input([{ id: 'x', defId: 'nodo_mai_visto', config: {} }]),
    );
    expect(problemi).toEqual([]);
  });

  it('senza definizioni il controllo tace invece di sbagliare', () => {
    const problemi = checkCampiObbligatori({
      nodes: [{ id: 'trigger_imap', defId: 'trigger_imap', config: {} }],
      edges: [],
    });
    expect(problemi).toEqual([]);
  });
});
