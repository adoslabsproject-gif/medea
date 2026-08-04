// @vitest-environment happy-dom

/**
 * La costruzione deve finire, anche quando niente risponde.
 *
 * I limiti c'erano già, ma erano tutti sul *numero* di passi: tre tentativi
 * per la prima strada, quaranta per l'agente. Con tre minuti concessi a ogni
 * chiamata, quaranta passi fanno due ore — e il 2026-08-04 è successo davvero:
 * il wizard è rimasto «in costruzione» per due ore esatte, senza un errore,
 * senza un modo di accorgersene. Non era rotto, faceva quello che c'era
 * scritto.
 *
 * Quello che l'utente sopporta si misura in minuti, non in passi. Qui il
 * modello non risponde mai, e la prova è che si smette lo stesso.
 *
 * @module features/workflows/wizard/budget.dom.test
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Un modello che non risponde: la promessa non si risolve mai, e non si
// risolverà nemmeno alla fine del test. È il caso peggiore, ed è quello che
// si è presentato.
vi.mock('../scaffold', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../scaffold');
  return {
    ...actual,
    createScaffoldLlm: vi.fn(() => Promise.resolve({})),
    runScaffold: vi.fn(
      (req: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    ),
    createAgentChat: vi.fn(() => Promise.resolve({})),
    runWorkflowAgent: vi.fn(
      () =>
        new Promise(() => {
          /* mai */
        }),
    ),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import { useWizard } from './useWizard';

describe('il tempo che la costruzione può prendersi', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('🚨 si ferma da sola invece di aspettare per ore', async () => {
    const { result } = renderHook(() => useWizard());

    act(() => {
      result.current.setGoal('Quando arriva una fattura, mettila in tabella');
    });
    act(() => {
      result.current.start();
    });
    expect(result.current.stage).toBe('building');

    // Quattro minuti e un secondo: il budget è scaduto.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 1000);
    });

    expect(result.current.stage).toBe('failed');
    expect(result.current.reason).toContain('minuti');
  });

  it('prima della scadenza sta ancora lavorando, non si arrende in anticipo', async () => {
    const { result } = renderHook(() => useWizard());

    act(() => {
      result.current.setGoal('Ogni mattina mandami il riepilogo');
    });
    act(() => {
      result.current.start();
    });

    // Tre minuti: una generazione lenta ma viva non va interrotta.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });

    expect(result.current.stage).toBe('building');
  });
});
