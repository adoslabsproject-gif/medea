// @vitest-environment happy-dom

/**
 * Che il pannello del relay si apra, e che dica cosa comporta **prima**
 * dell'interruttore.
 *
 * È l'unica funzione di Medea che apre una strada dall'esterno verso questo
 * computer. Un pannello che la accende senza spiegarla sarebbe un tranello,
 * e l'ordine in cui si legge fa parte della spiegazione.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({
  relayState: vi.fn(() => ({ connected: false })),
  subscribeRelay: vi.fn(() => () => undefined),
  startRelay: vi.fn(),
  stopRelay: vi.fn(),
  relayToken: vi.fn(() => Promise.resolve('t'.repeat(64))),
  relayUrl: vi.fn(() => ''),
  setRelayUrl: vi.fn(),
  relayEnabled: vi.fn(() => false),
  setRelayEnabled: vi.fn(),
}));

import { RelayDialog } from './RelayDialog';
import * as runtime from './runtime';

const relayUrl = vi.mocked(runtime.relayUrl);
const relayEnabled = vi.mocked(runtime.relayEnabled);
const setRelayEnabled = vi.mocked(runtime.setRelayEnabled);
const stopRelay = vi.mocked(runtime.stopRelay);
const relayState = vi.mocked(runtime.relayState);

beforeEach(() => {
  vi.clearAllMocks();
  relayUrl.mockReturnValue('');
  relayEnabled.mockReturnValue(false);
  relayState.mockReturnValue({ connected: false });
});
afterEach(cleanup);

describe('il pannello della raggiungibilità', () => {
  it('spiega che il computer non apre nessuna porta', () => {
    render(<RelayDialog onClose={vi.fn()} />);
    expect(screen.getByText(/nessuna porta aperta sul tuo router/)).toBeTruthy();
  });

  it('avvisa di cosa comporta accenderlo', () => {
    render(<RelayDialog onClose={vi.fn()} />);
    expect(screen.getByText(/può far eseguire un workflow su questo\s+computer/)).toBeTruthy();
  });

  it('non si accende senza un indirizzo: non ci sarebbe dove collegarsi', () => {
    render(<RelayDialog onClose={vi.fn()} />);
    const toggle: HTMLInputElement = screen.getByRole('checkbox');
    expect(toggle.disabled).toBe(true);
  });

  it('parte spento', () => {
    relayUrl.mockReturnValue('https://esempio.test/relay');
    render(<RelayDialog onClose={vi.fn()} />);

    expect(screen.getByText('Spento.')).toBeTruthy();
    const toggle: HTMLInputElement = screen.getByRole('checkbox');
    expect(toggle.checked).toBe(false);
  });

  it('spegnendolo chiude il canale davvero', () => {
    relayUrl.mockReturnValue('https://esempio.test/relay');
    relayEnabled.mockReturnValue(true);
    render(<RelayDialog onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(setRelayEnabled).toHaveBeenCalledWith(false);
    expect(stopRelay).toHaveBeenCalled();
  });

  it('mostra l’indirizzo pubblico solo quando il relay lo ha confermato', () => {
    relayUrl.mockReturnValue('https://esempio.test/relay');
    relayEnabled.mockReturnValue(true);
    relayState.mockReturnValue({ connected: true, installId: 'abc123abc123abc123abc123' });

    render(<RelayDialog onClose={vi.fn()} />);
    expect(screen.getByText(/\/h\/abc123abc123abc123abc123/)).toBeTruthy();
    expect(screen.getByText('Collegato.')).toBeTruthy();
  });
});
