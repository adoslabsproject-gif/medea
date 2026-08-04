// @vitest-environment happy-dom

/**
 * Quello che arriva dal wizard deve finire sul disco, subito.
 *
 * Il 2026-08-04 non ci finiva. Il wizard consegnava il workflow con `load`,
 * che dichiara il documento pulito; il salvataggio automatico i documenti
 * puliti non li tocca, quindi non veniva scritto mai. L'editor mostrava
 * «Salvato» — coerente con il suo stato interno, falso rispetto al disco — e
 * al primo clic su un'altra riga della lista dieci minuti di generazione
 * sparivano senza una domanda.
 *
 * @module features/workflows/useWorkflowEditor.adotta.test
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workflow } from './types';
import { useWorkflowEditor } from './useWorkflowEditor';

const save = vi.fn<(wf: Workflow, enabled: boolean) => Promise<number>>();
const list = vi.fn<() => Promise<unknown[]>>();
const get = vi.fn<(id: number) => Promise<Workflow | null>>();

vi.mock('./api', () => ({
  workflowApi: {
    save: (wf: Workflow, enabled: boolean) => save(wf, enabled),
    list: () => list(),
    get: (id: number) => get(id),
    remove: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

function generato(): Workflow {
  return {
    name: 'ordini',
    nodes: [{ id: 'trigger', defId: 'trigger_imap', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
  } as unknown as Workflow;
}

describe('un workflow che arriva dal wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(42);
    list.mockResolvedValue([]);
  });

  it('🚨 viene scritto sul disco senza aspettare che qualcuno prema Salva', async () => {
    // Il caso vero: generato, mostrato, mai salvato.
    const { result } = renderHook(() => useWorkflowEditor());
    await act(async () => {
      await result.current.adotta(generato());
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].name).toBe('ordini');
  });

  it('🚨 dopo il salvataggio porta con sé l’id, o la volta dopo ne crea un altro', async () => {
    const { result } = renderHook(() => useWorkflowEditor());
    await act(async () => {
      await result.current.adotta(generato());
    });

    await waitFor(() => {
      expect(result.current.workflow.id).toBe('42');
    });
  });

  it('🚨 se il disco rifiuta, resta da salvare invece di sembrare al sicuro', async () => {
    // Dichiararlo pulito dopo un errore è il modo esatto in cui si perse il
    // primo: l'autosave non riprova ciò che crede già scritto.
    save.mockRejectedValue(new Error('database bloccato'));
    const { result } = renderHook(() => useWorkflowEditor());
    await act(async () => {
      await result.current.adotta(generato());
    });

    expect(result.current.dirty).toBe(true);
    expect(result.current.notice).toContain('database bloccato');
    expect(result.current.workflow.name).toBe('ordini');
  });
});

describe('aprire un altro workflow dalla lista', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(7);
    list.mockResolvedValue([]);
    get.mockResolvedValue({ id: '99', name: 'altro', nodes: [], edges: [] });
  });

  it('🚨 scrive quello che si sta lasciando, invece di sostituirlo e basta', async () => {
    // È l'altra metà dello stesso guasto: l'autosave aspetta una pausa, e il
    // clic sulla riga accanto arriva prima.
    const { result } = renderHook(() => useWorkflowEditor());
    act(() => {
      result.current.change({ ...generato(), name: 'da salvare' });
    });
    await act(async () => {
      await result.current.open(99);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].name).toBe('da salvare');
    await waitFor(() => {
      expect(result.current.workflow.name).toBe('altro');
    });
  });

  it('un documento vuoto e mai toccato non crea una riga per essere stato lasciato', async () => {
    const { result } = renderHook(() => useWorkflowEditor());
    await act(async () => {
      await result.current.open(99);
    });

    expect(save).not.toHaveBeenCalled();
  });
});
