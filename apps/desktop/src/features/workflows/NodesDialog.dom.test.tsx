// @vitest-environment happy-dom

/**
 * Che il pannello dei nodi aggiuntivi si apra, e dica la verità.
 *
 * Due cose che non devono sparire con un refactor: l'avviso che sta per
 * eseguire codice di qualcun altro, e il verdetto sulla firma — che deve
 * leggersi anche quando è negativo, invece di essere nascosto dietro
 * un'icona verde che nessuno guarda.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({
  listCommunityNodes: vi.fn(),
  installCommunityNode: vi.fn(),
  uninstallCommunityNode: vi.fn(),
}));

import { NodesDialog } from './NodesDialog';
import * as runtime from './runtime';

const listCommunityNodes = vi.mocked(runtime.listCommunityNodes);
const uninstallCommunityNode = vi.mocked(runtime.uninstallCommunityNode);

function node(overrides: Partial<runtime.CommunityNode> = {}): runtime.CommunityNode {
  return {
    vendor: 'acme',
    id: 'fatture',
    version: '1.2.0',
    displayName: 'Fatture Acme',
    installedAt: '2026-08-01T10:00:00.000Z',
    verified: true,
    actionsCount: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listCommunityNodes.mockResolvedValue({ nodes: [], total: 0 });
  uninstallCommunityNode.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('il pannello dei nodi aggiuntivi', () => {
  it('avvisa che sta per installare codice di terzi', async () => {
    render(<NodesDialog onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/codice che verrà eseguito su questo computer/)).toBeTruthy();
    });
  });

  it('quando non ce n’è nessuno spiega che i preinstallati restano', async () => {
    render(<NodesDialog onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/193 preinstallati/)).toBeTruthy();
    });
  });

  it('mostra vendor, versione e numero di azioni', async () => {
    listCommunityNodes.mockResolvedValue({ nodes: [node()], total: 1 });

    render(<NodesDialog onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Fatture Acme')).toBeTruthy();
    });
    expect(screen.getByText(/acme\/fatture · v1\.2\.0 · 3 azioni/)).toBeTruthy();
  });

  it('dice quando la firma non è riconosciuta', async () => {
    // È l'informazione che decide se fidarsi: non può stare nascosta.
    listCommunityNodes.mockResolvedValue({ nodes: [node({ verified: false })], total: 1 });

    render(<NodesDialog onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('firma non riconosciuta')).toBeTruthy();
    });
  });

  it('rimuove il pacchetto quando si preme', async () => {
    listCommunityNodes.mockResolvedValue({ nodes: [node()], total: 1 });

    render(<NodesDialog onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rimuovi' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rimuovi' }));

    await waitFor(() => {
      expect(uninstallCommunityNode).toHaveBeenCalledWith('acme', 'fatture');
    });
  });

  it('dice che il motore non risponde, invece di mostrare una lista vuota', async () => {
    listCommunityNodes.mockRejectedValue(new Error('il runtime ha risposto 503'));

    render(<NodesDialog onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('il runtime ha risposto 503')).toBeTruthy();
    });
  });
});
