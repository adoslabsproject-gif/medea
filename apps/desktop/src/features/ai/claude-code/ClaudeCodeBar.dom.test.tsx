// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: { scegliCartella: vi.fn((): Promise<string | null> => Promise.resolve(null)) },
}));
vi.mock('../api', () => ({ aiApi: { claudeCode: api } }));

import { ClaudeCodeBar } from './ClaudeCodeBar';
import { cartellaScelta, comandiNoti, modelloScelto, ricordaComandi } from './settings';
import { SlashMenu } from './SlashMenu';

beforeEach(() => {
  localStorage.clear();
  api.scegliCartella.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe('ClaudeCodeBar', () => {
  it('il modello scelto resta scelto', () => {
    render(<ClaudeCodeBar inCorso={false} onFerma={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Modello di Claude Code'), {
      target: { value: 'opus' },
    });
    expect(modelloScelto()).toBe('opus');
  });

  /**
   * Senza una scelta Claude Code non deve trovarsi davanti i file
   * dell'utente: lo si dice, invece di lasciarlo scoprire.
   */
  it('senza una cartella dice che lavora isolato', () => {
    render(<ClaudeCodeBar inCorso={false} onFerma={vi.fn()} />);
    expect(screen.getByRole('button', { name: /nessuna \(isolato\)/ })).toBeTruthy();
    expect(screen.queryByLabelText('Togli la cartella di lavoro')).toBeNull();
  });

  it('la cartella scelta dalla finestra di sistema diventa quella di lavoro', async () => {
    api.scegliCartella.mockResolvedValue('/Users/anna/progetti/sito');
    render(<ClaudeCodeBar inCorso={false} onFerma={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /nessuna/ }));

    await waitFor(() => {
      expect(cartellaScelta()).toBe('/Users/anna/progetti/sito');
    });
    expect(screen.getByRole('button', { name: /sito/ })).toBeTruthy();
  });

  it('annullare la finestra non cambia niente', async () => {
    localStorage.setItem('medea.ai.claudeCode.cartella', '/prima');
    render(<ClaudeCodeBar inCorso={false} onFerma={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /prima/ }));

    await waitFor(() => {
      expect(api.scegliCartella).toHaveBeenCalled();
    });
    expect(cartellaScelta()).toBe('/prima');
  });

  it('la cartella si può togliere, e si torna isolati', () => {
    localStorage.setItem('medea.ai.claudeCode.cartella', '/progetto');
    render(<ClaudeCodeBar inCorso={false} onFerma={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Togli la cartella di lavoro'));

    expect(cartellaScelta()).toBeNull();
    expect(screen.getByRole('button', { name: /nessuna \(isolato\)/ })).toBeTruthy();
  });

  it('il pulsante per fermare c’è solo mentre un turno gira', () => {
    const onFerma = vi.fn();
    const { rerender } = render(<ClaudeCodeBar inCorso={false} onFerma={onFerma} />);
    expect(screen.queryByRole('button', { name: /Ferma/ })).toBeNull();

    rerender(<ClaudeCodeBar inCorso onFerma={onFerma} />);
    fireEvent.click(screen.getByRole('button', { name: /Ferma/ }));
    expect(onFerma).toHaveBeenCalledOnce();
  });
});

describe('SlashMenu', () => {
  it('propone i comandi che la CLI ha dichiarato, e sceglierne uno riempie il campo', () => {
    ricordaComandi(['compact', 'context', 'model']);
    expect(comandiNoti()).toHaveLength(3);
    const onScelta = vi.fn();
    render(<SlashMenu input="/co" onScelta={onScelta} />);

    expect(screen.getByRole('button', { name: '/compact' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '/model' })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('button', { name: '/context' }));
    expect(onScelta).toHaveBeenCalledWith('/context ');
  });

  it('se non si sta scrivendo un comando non compare', () => {
    ricordaComandi(['compact']);
    const { container } = render(<SlashMenu input="ciao" onScelta={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
