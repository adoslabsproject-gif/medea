// @vitest-environment happy-dom

/**
 * Il verdetto deve far vedere cosa ha costruito, non contarlo.
 *
 * Il 2026-08-04 la schermata diceva «3 nodi · 2 collegamenti», il nome e i
 * problemi — e dei nodi non se ne vedeva nemmeno uno. Un workflow generato
 * correttamente, col verdetto «si può attivare così com'è», è stato letto come
 * «non ha creato nulla»: una lettura giusta, perché di creato non si vedeva
 * niente.
 *
 * @module features/workflows/wizard/AnteprimaFlusso.dom.test
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasNode } from '../types';

import { AnteprimaFlusso } from './AnteprimaFlusso';

afterEach(cleanup);

const nodo = (id: string, defId: string, label?: string): CanvasNode => ({
  id,
  defId,
  x: 0,
  y: 0,
  config: {},
  ...(label ? { label } : {}),
});

describe('l’anteprima di cosa è stato costruito', () => {
  it('🚨 mostra ogni nodo, non solo quanti sono', () => {
    render(
      <AnteprimaFlusso
        nodes={[nodo('t', 'trigger_cron', 'Ogni venerdì'), nodo('m', 'action_send_email', 'Manda')]}
        edges={[{ from: 't', to: 'm' }]}
      />,
    );
    expect(screen.getByText('Ogni venerdì')).toBeTruthy();
    expect(screen.getByText('Manda')).toBeTruthy();
    expect(screen.getByText('trigger_cron')).toBeTruthy();
  });

  it('🚨 li mette in ordine di esecuzione: si parte dal trigger', () => {
    // Nell'elenco il trigger arriva per secondo; sullo schermo deve essere il
    // primo, perché è quello che fa partire tutto.
    render(
      <AnteprimaFlusso
        nodes={[nodo('m', 'action_send_email', 'Manda'), nodo('t', 'trigger_cron', 'Ogni venerdì')]}
        edges={[{ from: 't', to: 'm' }]}
      />,
    );
    const voci = screen.getAllByRole('listitem');
    expect(voci[0]?.textContent).toContain('Ogni venerdì');
    expect(voci[1]?.textContent).toContain('Manda');
  });

  it('🚨 segnala un nodo che non è appeso a niente', () => {
    // Non verrà mai eseguito: dirlo qui evita di scoprirlo dopo l'attivazione.
    render(
      <AnteprimaFlusso
        nodes={[nodo('t', 'trigger_cron'), nodo('m', 'action_send_email'), nodo('x', 'db_insert')]}
        edges={[{ from: 't', to: 'm' }]}
      />,
    );
    expect(screen.getAllByText('non collegato')).toHaveLength(1);
  });

  it('un nodo irraggiungibile compare comunque, in fondo', () => {
    // Nasconderlo sarebbe il modo peggiore di gestirlo: è proprio quello che
    // vale la pena vedere.
    render(
      <AnteprimaFlusso
        nodes={[nodo('t', 'trigger_cron'), nodo('orfano', 'db_insert')]}
        edges={[]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('senza nodi non mostra una lista vuota', () => {
    const { container } = render(<AnteprimaFlusso nodes={[]} edges={[]} />);
    expect(container.querySelector('ol')).toBeNull();
  });
});
