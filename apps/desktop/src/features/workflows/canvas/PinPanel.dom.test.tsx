// @vitest-environment happy-dom

/**
 * I dati fissati su un nodo.
 *
 * Quello che conta è che non si possa fissare qualcosa che il nodo dopo non
 * saprà leggere: il motore consegna quel valore così com'è, e un testo che
 * non è JSON diventerebbe un errore a valle invece che qui.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime', () => ({
  listPins: vi.fn(),
  setPin: vi.fn(),
  clearPin: vi.fn(),
}));

import * as runtime from '../runtime';

import { PinPanel } from './PinPanel';

const listPins = vi.mocked(runtime.listPins);
const setPin = vi.mocked(runtime.setPin);

beforeEach(() => {
  vi.clearAllMocks();
  listPins.mockResolvedValue([]);
  setPin.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('i dati fissati', () => {
  it('senza workflow nel motore spiega perché non si può ancora', () => {
    render(<PinPanel nodeId="a" runtimeId={undefined} />);
    expect(screen.getByText(/dopo la prima esecuzione/)).toBeTruthy();
  });

  it('rifiuta quello che non è JSON, prima di mandarlo al motore', async () => {
    render(<PinPanel nodeId="a" runtimeId="wf1" />);
    fireEvent.change(screen.getByLabelText('Risultato fissato'), {
      target: { value: 'non json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fissa' }));

    await waitFor(() => {
      expect(screen.getByText(/Deve essere JSON/)).toBeTruthy();
    });
    expect(setPin).not.toHaveBeenCalled();
  });

  it('fissa quello che si è scritto', async () => {
    render(<PinPanel nodeId="a" runtimeId="wf1" />);
    fireEvent.change(screen.getByLabelText('Risultato fissato'), {
      target: { value: '{"totale":42}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fissa' }));

    await waitFor(() => {
      expect(setPin).toHaveBeenCalledWith('wf1', 'a', { totale: 42 });
    });
  });

  it('offre di partire dall’ultima esecuzione, quando ce n’è una', () => {
    render(<PinPanel nodeId="a" runtimeId="wf1" lastOutput={{ result: { x: 1 } }} />);
    fireEvent.click(screen.getByRole('button', { name: /ultima esecuzione/ }));

    const editor: HTMLTextAreaElement = screen.getByLabelText('Risultato fissato');
    expect(editor.value).toContain('"x": 1');
  });

  it('senza esecuzioni non offre di prenderne una', () => {
    render(<PinPanel nodeId="a" runtimeId="wf1" />);
    expect(screen.queryByRole('button', { name: /ultima esecuzione/ })).toBeNull();
  });

  it('quando è fissato lo dice, e offre di tornare a eseguirlo', async () => {
    listPins.mockResolvedValue([{ nodeId: 'a', output: { x: 1 }, enabled: true }]);
    render(<PinPanel nodeId="a" runtimeId="wf1" />);

    await waitFor(() => {
      expect(screen.getByText(/non viene eseguito/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Torna a eseguirlo' })).toBeTruthy();
  });
});
