// @vitest-environment happy-dom

/**
 * Che la prova del singolo nodo funzioni davvero, dalla pressione al
 * risultato a schermo.
 *
 * Comprese le due cose che si sbagliano: un ingresso scritto male deve
 * fermarsi PRIMA di chiamare il motore — altrimenti l'errore che si legge
 * parla di JSON, non di quello che si è scritto — e un fallimento del nodo
 * deve leggersi come tale, non come un riquadro vuoto.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime', () => ({ testNode: vi.fn() }));

import * as runtime from '../runtime';
import type { CanvasNode } from '../types';

import { NodeTestPanel } from './NodeTestPanel';

const testNode = vi.mocked(runtime.testNode);

const node: CanvasNode = {
  id: 'calcolo',
  defId: 'action_run_js',
  x: 0,
  y: 0,
  config: { code: 'return { doppio: input.n * 2 };' },
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('la prova del singolo nodo', () => {
  it('non si può premere finché il motore non è pronto', () => {
    render(<NodeTestPanel node={node} nodes={[node]} edges={[]} ready={false} />);
    const button: HTMLButtonElement = screen.getByRole('button', { name: 'Prova questo nodo' });
    expect(button.disabled).toBe(true);
  });

  it('esegue e mostra quello che è uscito', async () => {
    testNode.mockResolvedValue({ ok: true, output: { doppio: 42 }, durationMs: 1 });

    render(<NodeTestPanel node={node} nodes={[node]} edges={[]} ready />);
    fireEvent.change(screen.getByLabelText('Cosa gli arriva'), { target: { value: '{"n":21}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prova questo nodo' }));

    await waitFor(() => {
      expect(screen.getByText('Riuscito')).toBeTruthy();
    });
    expect(screen.getByText(/"doppio": 42/)).toBeTruthy();
    expect(testNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'calcolo', input: { n: 21 } }),
    );
  });

  it('un fallimento si legge come tale, con il motivo', async () => {
    testNode.mockResolvedValue({ ok: false, error: 'input.n non è definito' });

    render(<NodeTestPanel node={node} nodes={[node]} edges={[]} ready />);
    fireEvent.click(screen.getByRole('button', { name: 'Prova questo nodo' }));

    await waitFor(() => {
      expect(screen.getByText('Fallito')).toBeTruthy();
    });
    expect(screen.getByText('input.n non è definito')).toBeTruthy();
  });

  it('un ingresso scritto male si ferma prima di disturbare il motore', async () => {
    render(<NodeTestPanel node={node} nodes={[node]} edges={[]} ready />);
    fireEvent.change(screen.getByLabelText('Cosa gli arriva'), { target: { value: '{n:21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prova questo nodo' }));

    await waitFor(() => {
      expect(screen.getByText(/deve essere JSON/)).toBeTruthy();
    });
    expect(testNode).not.toHaveBeenCalled();
  });

  it('dice che non ha prodotto niente, invece di lasciare un riquadro vuoto', async () => {
    testNode.mockResolvedValue({ ok: true });

    render(<NodeTestPanel node={node} nodes={[node]} edges={[]} ready />);
    fireEvent.click(screen.getByRole('button', { name: 'Prova questo nodo' }));

    await waitFor(() => {
      expect(screen.getByText('Non ha prodotto niente.')).toBeTruthy();
    });
  });
});
