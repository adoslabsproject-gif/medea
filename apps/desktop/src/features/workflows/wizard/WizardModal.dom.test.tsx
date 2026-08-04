// @vitest-environment happy-dom

/**
 * Che il wizard si apra davvero.
 *
 * I test puri dicono che le funzioni calcolano bene; non dicono che il
 * pannello compaia. Un componente può compilare, passare il controllo dei
 * tipi, e poi esplodere alla prima apertura per un `undefined` letto su un
 * oggetto che non c'è — e nessuna verifica statica lo prende.
 *
 * Qui si monta per davvero e si guarda cosa vede l'utente.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Il wizard parla col modello e col motore: qui non ci sono né l'uno né
// l'altro, e non è quello che si sta verificando.
vi.mock('../scaffold', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../scaffold');
  return {
    ...actual,
    createAgentChat: vi.fn(),
    runWorkflowAgent: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { WizardModal } from './WizardModal';

afterEach(cleanup);

describe('il wizard, montato davvero', () => {
  it('si apre chiedendo cosa deve fare l’automazione', () => {
    render(<WizardModal onClose={vi.fn()} onImport={vi.fn()} />);
    expect(screen.getByLabelText('Cosa deve fare questa automazione?')).toBeTruthy();
  });

  it('mostra gli esempi da cui partire', () => {
    render(<WizardModal onClose={vi.fn()} onImport={vi.fn()} />);
    // Il nome accessibile contiene titolo e testo dell'esempio: si sceglie
    // leggendo cosa si sta per chiedere, non indovinandolo dal titolo.
    expect(screen.getByRole('button', { name: /Riepilogo del mattino/ })).toBeTruthy();
  });

  it('non lascia costruire finché non si è scritto niente', () => {
    render(<WizardModal onClose={vi.fn()} onImport={vi.fn()} />);
    const build: HTMLButtonElement = screen.getByRole('button', { name: 'Costruisci' });
    expect(build.disabled).toBe(true);
  });

  it('un esempio riempie la casella invece di partire da solo', () => {
    // Quello che si chiede va sempre riletto prima di lanciarlo.
    render(<WizardModal onClose={vi.fn()} onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Riepilogo del mattino/ }));

    const goal: HTMLTextAreaElement = screen.getByLabelText('Cosa deve fare questa automazione?');
    expect(goal.value).toContain('Ogni mattina alle 8');
    const build: HTMLButtonElement = screen.getByRole('button', { name: 'Costruisci' });
    expect(build.disabled).toBe(false);
    // Non è partito: siamo ancora sulla domanda.
    expect(screen.queryByText('Sta costruendo il workflow')).toBeNull();
  });

  it('si chiude con Esc quando non sta lavorando', () => {
    const onClose = vi.fn();
    render(<WizardModal onClose={onClose} onImport={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('il giro completo, dall’obiettivo al verdetto', () => {
  it('mostra i passi mentre costruisce, poi il risultato', async () => {
    const { createAgentChat, runWorkflowAgent } = await import('../scaffold');

    vi.mocked(createAgentChat).mockResolvedValue(vi.fn() as never);
    vi.mocked(runWorkflowAgent).mockImplementation((req) => {
      // L'agente racconta un passo mentre lavora: è quello che il wizard
      // deve far vedere invece di un cerchio che gira.
      req.onStep?.({
        step: 1,
        tool: 'add_node',
        args: { id: 'ogni_ora', defId: 'trigger_cron' },
        result: { ok: true },
      });
      return Promise.resolve({
        ok: true,
        workflow: {
          name: 'promemoria',
          nodes: [
            {
              id: 'ogni_ora',
              defId: 'trigger_cron',
              x: 0,
              y: 0,
              config: { cronExpression: '0 8 * * *' },
            },
            { id: 'invia', defId: 'action_send_email', x: 0, y: 0, config: {} },
          ],
          edges: [{ from: 'ogni_ora', to: 'invia' }],
        },
        steps: [],
        remainingIssues: [],
      });
    });

    render(<WizardModal onClose={vi.fn()} onImport={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Cosa deve fare questa automazione?'), {
      target: { value: 'mandami un promemoria ogni mattina' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Costruisci' }));

    // Il passo compare in italiano, non col nome dello strumento.
    await waitFor(() => {
      expect(screen.getByText('Ecco cosa ho costruito')).toBeTruthy();
    });
    expect(screen.getByText('promemoria')).toBeTruthy();
    expect(screen.getByRole('button', { name: "Apri nell'editor" })).toBeTruthy();
  });

  it('quando l’agente non ce la fa, lo dice e offre di riprovare', async () => {
    const { createAgentChat, runWorkflowAgent } = await import('../scaffold');
    vi.mocked(createAgentChat).mockResolvedValue(vi.fn() as never);
    vi.mocked(runWorkflowAgent).mockResolvedValue({
      ok: false,
      steps: [],
      reason: 'Non ho trovato un nodo che sappia leggere quel formato.',
      violations: [],
      qualityIssues: [],
    });

    render(<WizardModal onClose={vi.fn()} onImport={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Cosa deve fare questa automazione?'), {
      target: { value: 'fai una cosa impossibile' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Costruisci' }));

    await waitFor(() => {
      expect(screen.getByText('Non ce l’ho fatta')).toBeTruthy();
    });
    expect(screen.getByText(/Non ho trovato un nodo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
  });
});
