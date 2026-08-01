// @vitest-environment happy-dom

/**
 * Che il pannello dei segreti si apra, e che non mostri mai un valore.
 *
 * L'ultima è la cosa che conta: un valore riletto a schermo non serve a chi
 * lo ha scritto e serve molto a chi guarda alle sue spalle. È una proprietà
 * che si perde con un refactor distratto, quindi va asserita.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let names: string[] = [];

vi.mock('./runtime/secrets', () => ({
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  secretNames: () => names,
  normalizeSecretName: (raw: string) =>
    raw
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .replace(/^_+|_+$/g, ''),
}));

import * as secrets from './runtime/secrets';
import { SecretsDialog } from './SecretsDialog';

const setSecret = vi.mocked(secrets.setSecret);
const deleteSecret = vi.mocked(secrets.deleteSecret);

beforeEach(() => {
  vi.clearAllMocks();
  names = [];
  setSecret.mockResolvedValue('CHIAVE');
  deleteSecret.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('il pannello dei segreti', () => {
  it('spiega cosa farsene, quando non ce n’è nessuno', () => {
    render(<SecretsDialog onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(/Nessun segreto/)).toBeTruthy();
    expect(screen.getByText('{{secrets.NOME}}')).toBeTruthy();
  });

  it('mostra il nome e come si usa, mai il valore', () => {
    names = ['CHIAVE_API'];
    render(<SecretsDialog onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.getByText('CHIAVE_API')).toBeTruthy();
    expect(screen.getByText('{{secrets.CHIAVE_API}}')).toBeTruthy();
  });

  it('la casella del valore non restituisce mai quello che c’è dentro', () => {
    names = ['CHIAVE_API'];
    render(<SecretsDialog onClose={vi.fn()} onChanged={vi.fn()} />);

    const value: HTMLInputElement = screen.getByLabelText('Valore del segreto');
    expect(value.value).toBe('');
    expect(value.type).toBe('password');
  });

  it('rifiuta un valore vuoto invece di salvare un segreto che a runtime non dirà perché fallisce', async () => {
    render(<SecretsDialog onClose={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Nome del segreto'), {
      target: { value: 'chiave api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));

    await waitFor(() => {
      expect(screen.getByText(/Serve un valore/)).toBeTruthy();
    });
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('mostra in anticipo il nome che uscirà', () => {
    render(<SecretsDialog onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Nome del segreto'), {
      target: { value: 'chiave api' },
    });
    expect(screen.getByText('{{secrets.CHIAVE_API}}')).toBeTruthy();
  });

  it('salva e avvisa che c’è da riconsegnare al motore', async () => {
    const onChanged = vi.fn();
    render(<SecretsDialog onClose={vi.fn()} onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText('Nome del segreto'), { target: { value: 'CHIAVE' } });
    fireEvent.change(screen.getByLabelText('Valore del segreto'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva' }));

    await waitFor(() => {
      expect(setSecret).toHaveBeenCalledWith('CHIAVE', 'abc123');
    });
    expect(onChanged).toHaveBeenCalled();
  });
});
