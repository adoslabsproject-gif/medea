// @vitest-environment happy-dom

/**
 * La palette dei comandi.
 *
 * Due comportamenti che si sbagliano facilmente: un comando disabilitato non
 * deve comparire — offrirlo e poi non farlo succedere è peggio che ometterlo
 * — e la scelta deve tornare in cima a ogni ricerca, altrimenti si preme
 * Invio su una voce che non si è letta.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette, type Comando } from './CommandPalette';

afterEach(cleanup);

function comandi(overrides: Partial<Comando>[] = []): Comando[] {
  return [
    { id: 'a', label: 'Salva', run: vi.fn() },
    { id: 'b', label: 'Pubblica', hint: 'in produzione', run: vi.fn() },
    { id: 'c', label: 'Esporta come immagine', run: vi.fn() },
    ...overrides.map((o, i) => ({ id: `x${String(i)}`, label: 'Extra', run: vi.fn(), ...o })),
  ];
}

describe('la palette dei comandi', () => {
  it('elenca quello che si può fare', () => {
    render(<CommandPalette comandi={comandi()} onClose={vi.fn()} />);
    expect(screen.getByText('Salva')).toBeTruthy();
    expect(screen.getByText('Pubblica')).toBeTruthy();
  });

  it('non mostra i comandi disabilitati', () => {
    // Offrirli e poi non farli succedere è peggio che ometterli.
    render(
      <CommandPalette
        comandi={comandi([{ label: 'Non si può', disabled: true }])}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Non si può')).toBeNull();
  });

  it('cerca anche nel suggerimento, non solo nel nome', () => {
    render(<CommandPalette comandi={comandi()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Cerca un comando'), {
      target: { value: 'produzione' },
    });
    expect(screen.getByText('Pubblica')).toBeTruthy();
    expect(screen.queryByText('Salva')).toBeNull();
  });

  it('dice quando non trova niente', () => {
    render(<CommandPalette comandi={comandi()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Cerca un comando'), { target: { value: 'zzz' } });
    expect(screen.getByText(/Nessun comando/)).toBeTruthy();
  });

  it('eseguendo un comando si chiude', () => {
    const onClose = vi.fn();
    const lista = comandi();
    render(<CommandPalette comandi={lista} onClose={onClose} />);

    fireEvent.click(screen.getByText('Salva'));
    expect(lista[0]?.run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Invio esegue quello scelto', () => {
    const lista = comandi();
    render(<CommandPalette comandi={lista} onClose={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(lista[0]?.run).toHaveBeenCalled();
  });

  it('le frecce cambiano la scelta', () => {
    const lista = comandi();
    render(<CommandPalette comandi={lista} onClose={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(lista[1]?.run).toHaveBeenCalled();
  });

  it('Esc chiude senza eseguire niente', () => {
    const onClose = vi.fn();
    const lista = comandi();
    render(<CommandPalette comandi={lista} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(lista[0]?.run).not.toHaveBeenCalled();
  });
});
