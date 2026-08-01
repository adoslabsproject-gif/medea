// @vitest-environment happy-dom

/**
 * La finestra dei form.
 *
 * Le cose che devono restare vere: un form spento lo dice (altrimenti si manda
 * l'indirizzo a qualcuno e si scopre da lui che non risponde), gli invii si
 * leggono senza uscire dalla finestra, e l'indirizzo si copia con un gesto
 * solo — è tutto il motivo per cui questa finestra esiste.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listForms = vi.fn();
const submissions = vi.fn();

vi.mock('./runtime', () => ({
  listForms: (...a: unknown[]) => listForms(...a) as unknown,
  submissions: (...a: unknown[]) => submissions(...a) as unknown,
}));

const { FormsDialog } = await import('./FormsDialog');

const FORM = {
  workflowId: 'wf-1',
  workflowName: 'Contatti dal sito',
  enabled: true,
  nodeId: 'form-abc',
  title: 'Scrivici',
  fieldsCount: 3,
  formUrl: 'http://127.0.0.1:39100/forms/wf-1/form-abc',
  submissionCount: 4,
  lastSubmissionAt: '2026-07-30T10:00:00.000Z',
};

beforeEach(() => {
  listForms.mockReset();
  submissions.mockReset();
  listForms.mockResolvedValue([FORM]);
  submissions.mockResolvedValue([]);
});
afterEach(cleanup);

describe('la finestra dei form', () => {
  it('mostra titolo, indirizzo e quanti invii', async () => {
    render(<FormsDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByText('Scrivici')).toBeTruthy();
    expect(screen.getByText(FORM.formUrl)).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('invii')).toBeTruthy();
  });

  it('dice quando un form è spento', async () => {
    // Un indirizzo che risponde con un errore è peggio di nessun indirizzo:
    // si scopre da chi lo riceve.
    listForms.mockResolvedValue([{ ...FORM, enabled: false }]);
    render(<FormsDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByText(/spento, non risponde/)).toBeTruthy();
  });

  it('legge cosa è arrivato solo quando lo si chiede', async () => {
    submissions.mockResolvedValue([
      {
        runId: 'r1',
        status: 'success',
        startedAt: '2026-07-30T10:00:00.000Z',
        finishedAt: null,
        durationMs: 12,
        input: { nome: 'Mario', email: 'mario@example.com' },
      },
    ]);
    render(<FormsDialog onClose={vi.fn()} onOpen={vi.fn()} />);

    // Nessuna lettura finché la scheda è chiusa: gli invii possono essere
    // centinaia e non servono per mostrare l'elenco.
    await screen.findByText('Scrivici');
    expect(submissions).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Cosa è arrivato'));
    expect(await screen.findByText(/Mario/)).toBeTruthy();
    expect(screen.getByText(/mario@example.com/)).toBeTruthy();
  });

  it('copia l’indirizzo', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<FormsDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByText('Copia'));
    expect(writeText).toHaveBeenCalledWith(FORM.formUrl);
    await waitFor(() => {
      expect(screen.getByText('Copiato')).toBeTruthy();
    });
  });

  it('porta al workflow che sta dietro', async () => {
    const onOpen = vi.fn();
    render(<FormsDialog onClose={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(await screen.findByText('Apri il workflow'));
    expect(onOpen).toHaveBeenCalledWith('wf-1');
  });

  it('senza form spiega come se ne fa uno', async () => {
    listForms.mockResolvedValue([]);
    render(<FormsDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByText(/Nessun form/)).toBeTruthy();
  });

  it('se il motore non risponde lo dice invece di restare vuota', async () => {
    listForms.mockRejectedValue(new Error('runtime spento'));
    render(<FormsDialog onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByText('runtime spento')).toBeTruthy();
  });

  it('Esc chiude', async () => {
    const onClose = vi.fn();
    render(<FormsDialog onClose={onClose} onOpen={vi.fn()} />);
    await screen.findByText('Scrivici');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
