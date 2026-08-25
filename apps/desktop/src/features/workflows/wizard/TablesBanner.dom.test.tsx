// @vitest-environment happy-dom

/**
 * Che il pannello delle tabelle compaia quando serve — e, soprattutto, che
 * **non** compaia quando non serve.
 *
 * La seconda è la parte delicata: un avviso che appare su ogni workflow,
 * anche quelli che non toccano nessun database, si impara a ignorare in due
 * giorni, e allora tanto vale non averlo.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtime', async () => {
  const plan = await vi.importActual<Record<string, unknown>>('../runtime/table-plan');
  return {
    ...plan,
    databaseDelWorkflow: vi.fn(() => Promise.resolve('db1')),
    existingTables: vi.fn(),
    createTables: vi.fn(),
  };
});

import * as runtime from '../runtime';
import type { Workflow } from '../types';

import { TablesBanner } from './TablesBanner';

const existingTables = vi.mocked(runtime.existingTables);
const createTables = vi.mocked(runtime.createTables);

function withInsert(table: string): Workflow {
  return {
    // L'id serve: l'archivio è DI QUESTO workflow, e senza id non c'è a chi
    // legarlo — il banner tace di proposito finché non è salvato.
    id: '7',
    name: 'prova',
    nodes: [
      {
        id: 'salva',
        defId: 'db_insert',
        x: 0,
        y: 0,
        config: { table, rowJson: { mittente: 'a@b.it' } },
      },
    ],
    edges: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  existingTables.mockResolvedValue([]);
  createTables.mockResolvedValue({ created: ['seguiti'], problems: [] });
});
afterEach(cleanup);

describe('il pannello delle tabelle mancanti', () => {
  /**
   * L'archivio appartiene a un workflow preciso, e prima del salvataggio quel
   * workflow non ha un id: crearlo adesso vorrebbe dire un archivio senza
   * padrone, che nessuna cancellazione saprebbe più portarsi via.
   */
  it('tace finché il workflow non è stato salvato', () => {
    const { id: _tolto, ...senzaId } = withInsert('seguiti');
    const { container } = render(<TablesBanner workflow={senzaId as never} />);
    expect(container.textContent).toBe('');
    expect(existingTables).not.toHaveBeenCalled();
  });

  it('non compare su un workflow che non tocca nessun database', () => {
    const { container } = render(
      <TablesBanner
        workflow={{
          name: 'prova',
          nodes: [{ id: 'a', defId: 'action_send_email', x: 0, y: 0, config: {} }],
          edges: [],
        }}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('non compare se la tabella esiste già', async () => {
    existingTables.mockResolvedValue(['seguiti']);
    const { container } = render(<TablesBanner workflow={withInsert('seguiti')} />);

    await waitFor(() => {
      expect(existingTables).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('elenca la tabella mancante con le colonne che il workflow nomina', async () => {
    render(<TablesBanner workflow={withInsert('seguiti')} />);

    await waitFor(() => {
      expect(screen.getByText('seguiti')).toBeTruthy();
    });
    expect(screen.getByText('(id, mittente)')).toBeTruthy();
  });

  it('le crea solo quando si preme', async () => {
    render(<TablesBanner workflow={withInsert('seguiti')} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Creale' })).toBeTruthy();
    });
    // Fino a qui nessuno ha toccato l'archivio.
    expect(createTables).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Creale' }));
    await waitFor(() => {
      expect(screen.getByText(/Tabelle create: seguiti/)).toBeTruthy();
    });
  });

  it('dice cosa non è riuscito, invece di dichiarare un successo', async () => {
    createTables.mockResolvedValue({ created: [], problems: ['seguiti: nome riservato'] });

    render(<TablesBanner workflow={withInsert('seguiti')} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Creale' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Creale' }));

    await waitFor(() => {
      expect(screen.getByText(/nome riservato/)).toBeTruthy();
    });
  });
});
