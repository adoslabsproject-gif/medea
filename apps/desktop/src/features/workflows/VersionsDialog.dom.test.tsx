// @vitest-environment happy-dom

/**
 * Che il pannello delle versioni si apra, e mostri quello che c'è.
 *
 * Comprese le due cose che si sbagliano facilmente: l'elenco vuoto che deve
 * spiegarsi invece di sembrare un errore, e il motore che non risponde — che
 * va detto, non nascosto dietro una lista vuota identica al caso normale.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  rollbackVersion: vi.fn(),
  snapshotVersion: vi.fn(),
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
