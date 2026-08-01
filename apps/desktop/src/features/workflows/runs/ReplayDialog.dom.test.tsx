// @vitest-environment happy-dom

/**
 * Ripartire cambiando i dati di prima.
 *
 * La cosa che conta: si può cambiare solo l'uscita dei nodi **a monte**.
 * Quelli dopo verranno rieseguiti, e riscriverne l'uscita non vorrebbe dire
 * niente — sarebbe un campo che promette qualcosa che il motore ignora.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayDialog } from './ReplayDialog';
import type { RunStep } from './types';

const upstream: RunStep[] = [
  { nodeId: 'leggi', status: 'success', output: '{"totale":10}' },
  { nodeId: 'calcola', status: 'success', output: '{"iva":2.2}' },
];

afterEach(cleanup);

describe('ripartire da un nodo', () => {
  it('mostra cosa avevano prodotto i nodi prima', () => {
    render(
      <ReplayDialog fromNode="invia" upstream={upstream} onClose={vi.fn()} onReplay={vi.fn()} />,
    );
    expect(screen.getByText('leggi')).toBeTruthy();
    expect(screen.getByText('calcola')).toBeTruthy();
  });

  it('senza nodi prima lo dice, invece di mostrare il vuoto', () => {
    render(<ReplayDialog fromNode="via" upstream={[]} onClose={vi.fn()} onReplay={vi.fn()} />);
    expect(screen.getByText(/riparte dall’inizio/)).toBeTruthy();
  });

  it('chi non si tocca non finisce fra le modifiche', () => {
    // Mandare al motore anche i dati non toccati sarebbe innocuo ma falso:
    // direbbe «ho cambiato tutto» quando non si è cambiato niente.
    const onReplay = vi.fn();
    render(
      <ReplayDialog fromNode="invia" upstream={upstream} onClose={vi.fn()} onReplay={onReplay} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Riparti' }));
    expect(onReplay).toHaveBeenCalledWith({});
  });

  it('quello che si cambia arriva al motore', () => {
    const onReplay = vi.fn();
    render(
      <ReplayDialog fromNode="invia" upstream={upstream} onClose={vi.fn()} onReplay={onReplay} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Cambia' })[0]!);
    fireEvent.change(screen.getByLabelText('Uscita di leggi'), {
      target: { value: '{"totale":999}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Riparti' }));

    expect(onReplay).toHaveBeenCalledWith({ leggi: { totale: 999 } });
  });

  it('un dato scritto male si ferma qui, non al motore', () => {
    const onReplay = vi.fn();
    render(
      <ReplayDialog fromNode="invia" upstream={upstream} onClose={vi.fn()} onReplay={onReplay} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Cambia' })[0]!);
    fireEvent.change(screen.getByLabelText('Uscita di leggi'), { target: { value: 'non json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Riparti' }));

    expect(screen.getByText(/non è JSON/)).toBeTruthy();
    expect(onReplay).not.toHaveBeenCalled();
  });

  it('si può cambiare idea e lasciare com’era', () => {
    const onReplay = vi.fn();
    render(
      <ReplayDialog fromNode="invia" upstream={upstream} onClose={vi.fn()} onReplay={onReplay} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Cambia' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Lascia com’era' }));
    fireEvent.click(screen.getByRole('button', { name: 'Riparti' }));

    expect(onReplay).toHaveBeenCalledWith({});
  });
});
