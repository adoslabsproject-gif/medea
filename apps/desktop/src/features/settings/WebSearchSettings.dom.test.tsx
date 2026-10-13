// @vitest-environment happy-dom

/**
 * Le impostazioni della ricerca sul web.
 *
 * Due promesse da tenere: le chiavi finiscono nel portachiavi con il nome che
 * lo strumento in Rust va a leggere, e la conferma sulle pagine è attiva
 * finché l'utente non la toglie di sua mano.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { secretsApi } = vi.hoisted(() => ({
  secretsApi: {
    get: vi.fn((_k: string) => Promise.resolve(null as string | null)),
    set: vi.fn((_k: string, _v: string) => Promise.resolve()),
    delete: vi.fn((_k: string) => Promise.resolve()),
  },
}));
vi.mock('../secrets/api', () => ({ secretsApi }));

import { confermaWebDisattivata } from '../ai/web-consent';

import { MOTORI, WebSearchSettings } from './WebSearchSettings';

beforeEach(() => {
  localStorage.clear();
  secretsApi.get.mockReset().mockResolvedValue(null);
  secretsApi.set.mockReset().mockResolvedValue(undefined);
  secretsApi.delete.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('le chiavi dei motori di ricerca', () => {
  it('una chiave scritta finisce nel portachiavi, senza spazi attorno', async () => {
    render(<WebSearchSettings />);
    fireEvent.change(screen.getByLabelText(/Chiave Brave Search/), {
      target: { value: '  BSA-chiave  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salva chiave Brave Search' }));

    await waitFor(() => {
      expect(secretsApi.set).toHaveBeenCalledWith('web.key.brave', 'BSA-chiave');
    });
  });

  it('una chiave svuotata viene tolta dal portachiavi', async () => {
    secretsApi.get.mockImplementation((k) =>
      Promise.resolve(k === 'web.key.tavily' ? 'tvly-vecchia' : null),
    );
    render(<WebSearchSettings />);
    const campo: HTMLInputElement = await screen.findByDisplayValue('tvly-vecchia');
    fireEvent.change(campo, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salva chiave Tavily' }));

    await waitFor(() => {
      expect(secretsApi.delete).toHaveBeenCalledWith('web.key.tavily');
    });
    expect(secretsApi.set).not.toHaveBeenCalled();
  });

  /**
   * I nomi delle voci vivono in due linguaggi. Se divergessero, la chiave si
   * salverebbe senza errori e lo strumento continuerebbe a non trovarla.
   */
  it('i nomi delle voci sono quelli che lo strumento in Rust va a leggere', () => {
    const rust = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../src-tauri/src/ai_tools/web/search.rs',
      ),
      'utf8',
    );
    for (const m of MOTORI) {
      expect(rust, `Rust non legge «${m.voce}»`).toContain(`"${m.voce}"`);
    }
  });
});

describe('la conferma sulle pagine', () => {
  it('è attiva finché l’utente non la toglie', () => {
    render(<WebSearchSettings />);
    const casella: HTMLInputElement = screen.getByRole('checkbox');
    expect(casella.checked).toBe(false);
    expect(confermaWebDisattivata()).toBe(false);

    fireEvent.click(casella);
    expect(confermaWebDisattivata()).toBe(true);

    fireEvent.click(casella);
    expect(confermaWebDisattivata()).toBe(false);
  });
});
