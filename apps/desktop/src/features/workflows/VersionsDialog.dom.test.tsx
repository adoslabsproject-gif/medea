// @vitest-environment happy-dom

/**
 * Che il pannello delle versioni si apra, e mostri quello che c'è.
 *
 * Comprese le due cose che si sbagliano facilmente: l'elenco vuoto che deve
 * spiegarsi invece di sembrare un errore, e il motore che non risponde — che
 * va detto, non nascosto dietro una lista vuota identica al caso normale.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  rollbackVersion: vi.fn(),
  snapshotVersion: vi.fn(),
  diffVersions: vi.fn(),
}));

import * as runtime from './runtime';
import type { Workflow } from './types';
import { VersionsDialog } from './VersionsDialog';

const listVersions = vi.mocked(runtime.listVersions);

const workflow: Workflow = { id: '1', name: 'prova', nodes: [], edges: [] };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('il pannello delle versioni', () => {
  it('elenca le versioni con numero, data e motivo', async () => {
    listVersions.mockResolvedValue([
      {
        id: 'v2',
        versionNumber: 2,
        createdAt: '2026-08-01T10:00:00.000Z',
        createdBy: null,
        comment: 'prima di cambiare il cron',
      },
    ]);

    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('#2')).toBeTruthy();
    });
    expect(screen.getByText('prima di cambiare il cron')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ripristina' })).toBeTruthy();
  });

  it('chiama «salvataggio automatico» quello che il motore ha preso da solo', async () => {
    listVersions.mockResolvedValue([
      {
        id: 'v1',
        versionNumber: 1,
        createdAt: '2026-08-01T09:00:00.000Z',
        createdBy: null,
        comment: 'auto',
      },
    ]);

    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('salvataggio automatico')).toBeTruthy();
    });
  });

  it('spiega l’elenco vuoto invece di lasciarlo sembrare un errore', async () => {
    listVersions.mockResolvedValue([]);

    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Nessuna versione/)).toBeTruthy();
    });
  });

  it('dice che il motore non risponde, invece di mostrare una lista vuota', async () => {
    // Un errore travestito da «non c'è niente» è il modo migliore per far
    // cercare all'utente un problema che non esiste.
    listVersions.mockRejectedValue(new Error('il runtime ha risposto 503'));

    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('il runtime ha risposto 503')).toBeTruthy();
    });
  });
});

describe('il confronto fra versioni', () => {
  const due = [
    {
      id: 'v1',
      versionNumber: 1,
      createdAt: '2026-08-01T09:00:00.000Z',
      createdBy: null,
      comment: 'auto',
    },
    {
      id: 'v2',
      versionNumber: 2,
      createdAt: '2026-08-01T10:00:00.000Z',
      createdBy: null,
      comment: null,
    },
  ];

  it('serve sceglierne due: con una sola non si confronta niente', async () => {
    listVersions.mockResolvedValue(due);
    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Confronta' })).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Confronta' })[0]!);
    expect(screen.queryByRole('button', { name: 'Cosa è cambiato' })).toBeNull();
  });

  it('con due scelte, dice dove guardare', async () => {
    listVersions.mockResolvedValue(due);
    vi.mocked(runtime.diffVersions).mockResolvedValue({
      added: ['invia'],
      removed: [],
      changed: ['ogni_ora'],
    });

    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Confronta' })).toHaveLength(2);
    });

    for (const b of screen.getAllByRole('button', { name: 'Confronta' })) fireEvent.click(b);
    fireEvent.click(screen.getByRole('button', { name: 'Cosa è cambiato' }));

    await waitFor(() => {
      expect(screen.getByText(/invia/)).toBeTruthy();
    });
    expect(screen.getByText(/ogni_ora/)).toBeTruthy();
  });

  it('due versioni identiche lo dicono, invece di mostrare tre righe vuote', async () => {
    listVersions.mockResolvedValue(due);
    vi.mocked(runtime.diffVersions).mockResolvedValue({ added: [], removed: [], changed: [] });

    render(
      <VersionsDialog runtimeId="wf1" workflow={workflow} onClose={vi.fn()} onLoad={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Confronta' })).toHaveLength(2);
    });
    for (const b of screen.getAllByRole('button', { name: 'Confronta' })) fireEvent.click(b);
    fireEvent.click(screen.getByRole('button', { name: 'Cosa è cambiato' }));

    await waitFor(() => {
      expect(screen.getByText(/Nessuna differenza/)).toBeTruthy();
    });
  });
});
