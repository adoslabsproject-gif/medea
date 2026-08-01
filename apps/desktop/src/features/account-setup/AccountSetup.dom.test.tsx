// @vitest-environment happy-dom

/**
 * La via d'uscita del primo avvio.
 *
 * Prima non c'era: chi voleva soltanto vedere com'è fatta l'app doveva
 * consegnare le credenziali della propria posta per scoprirlo. Adesso c'è un
 * modo di entrare e guardare — e questi test lo verificano **senza** che
 * nessuno debba cancellare la propria configurazione per provarlo.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { AccountSetup } from './AccountSetup';

afterEach(cleanup);

describe('la configurazione del primo account', () => {
  it('al primo avvio offre di entrare senza configurare niente', () => {
    // `onSkip` senza `onCancel` è la combinazione del primo avvio: non c'è un
    // «indietro» dove tornare, ma c'è un «avanti» per guardare.
    render(<AccountSetup onSaved={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Guarda prima l’app/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Indietro/ })).toBeNull();
  });

  it('il pulsante fa davvero entrare', () => {
    const onSkip = vi.fn();
    render(<AccountSetup onSaved={vi.fn()} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole('button', { name: /Guarda prima l’app/ }));
    expect(onSkip).toHaveBeenCalled();
  });

  it('quando un account c’è già, offre «indietro» e non «guarda prima»', () => {
    // Con un account configurato quel pulsante non vorrebbe dire niente:
    // l'app la si sta già guardando.
    render(<AccountSetup onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Indietro/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Guarda prima l’app/ })).toBeNull();
  });

  it('il menù dei provider elenca le scelte, con Gmail per prima', () => {
    render(<AccountSetup onSaved={vi.fn()} onSkip={vi.fn()} />);
    const select: HTMLSelectElement = screen.getByLabelText('Provider');
    const labels = [...select.options].map((o) => o.textContent);

    expect(labels[0]).toContain('Gmail');
    expect(labels.length).toBeGreaterThan(1);
  });
});
