// @vitest-environment happy-dom

/**
 * Cosa succede quando un nodo fallisce.
 *
 * Il motore lo sapeva fare da sempre; nessun pannello lo esponeva. Questi
 * test verificano che i valori finiscano dove il motore li cerca — `config`
 * per i tentativi, il **nodo** per `continueOnFail` — perché scriverli nel
 * posto sbagliato produrrebbe un pannello che sembra funzionare e un motore
 * che non cambia comportamento.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasNode, NodeDef } from '../types';

import { ErrorHandling } from './ErrorHandling';

const nodo: CanvasNode = { id: 'a', defId: 'action_http', x: 0, y: 0, config: {} };
const def: NodeDef = { defId: 'action_http', type: 'action', label: 'HTTP' };

afterEach(cleanup);

describe('la gestione degli errori', () => {
  it('i tentativi finiscono nella configurazione, dove il motore li cerca', () => {
    const onConfigChange = vi.fn();
    render(
      <ErrorHandling
        node={nodo}
        def={def}
        onNodeChange={vi.fn()}
        onConfigChange={onConfigChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Tentativi in più'), { target: { value: '3' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ retryCount: '3' }));
  });

  it('l’attesa compare solo quando c’è qualcosa da riprovare', () => {
    const { rerender } = render(
      <ErrorHandling node={nodo} def={def} onNodeChange={vi.fn()} onConfigChange={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/Attesa fra un tentativo/)).toBeNull();

    rerender(
      <ErrorHandling
        node={{ ...nodo, config: { retryCount: '2' } }}
        def={def}
        onNodeChange={vi.fn()}
        onConfigChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Attesa fra un tentativo/)).toBeTruthy();
  });

  it('«prosegui» finisce sul NODO, non fra i suoi campi', () => {
    // È lì che il motore lo legge: scriverlo in `config` produrrebbe un
    // pannello che sembra funzionare e un motore che non cambia niente.
    const onNodeChange = vi.fn();
    render(
      <ErrorHandling node={nodo} def={def} onNodeChange={onNodeChange} onConfigChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /Prosegui lo stesso/ }));
    expect(onNodeChange).toHaveBeenCalledWith({ continueOnFail: true });
  });

  it('le categorie compaiono solo dopo aver scelto di proseguire', () => {
    const { rerender } = render(
      <ErrorHandling node={nodo} def={def} onNodeChange={vi.fn()} onConfigChange={vi.fn()} />,
    );
    expect(screen.queryByText('Rete')).toBeNull();

    rerender(
      <ErrorHandling
        node={{ ...nodo, continueOnFail: true }}
        def={def}
        onNodeChange={vi.fn()}
        onConfigChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Rete')).toBeTruthy();
  });

  it('un nodo che riprova da sé lo dice, invece di offrire tentativi doppi', () => {
    render(
      <ErrorHandling
        node={nodo}
        def={{ ...def, selfManagedRetry: true }}
        onNodeChange={vi.fn()}
        onConfigChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/riprova da sé/)).toBeTruthy();
    expect(screen.queryByLabelText('Tentativi in più')).toBeNull();
  });
});
