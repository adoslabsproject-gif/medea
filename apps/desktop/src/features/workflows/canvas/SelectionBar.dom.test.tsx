// @vitest-environment happy-dom

/**
 * La barra della selezione multipla.
 *
 * La cosa che conta è **quando non compare**: con un nodo solo il pannello di
 * configurazione ha già quelle azioni in fondo, e una barra che dice le stesse
 * cose in un posto diverso è rumore.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelectionBar } from './SelectionBar';

afterEach(cleanup);

function barra(count: number, azioni = {}) {
  return render(
    <SelectionBar
      count={count}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
      onClear={vi.fn()}
      {...azioni}
    />,
  );
}

describe('la barra della selezione', () => {
  it('non compare senza selezione', () => {
    const { container } = barra(0);
    expect(container.textContent).toBe('');
  });

  it('non compare con un nodo solo: ci pensa il pannello', () => {
    const { container } = barra(1);
    expect(container.textContent).toBe('');
  });

  it('compare da due in su, e dice quanti sono', () => {
    barra(6);
    expect(screen.getByText('6 nodi selezionati')).toBeTruthy();
  });

  it('elimina tutti quelli presi', () => {
    const onDelete = vi.fn();
    barra(3, { onDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Elimina' }));
    expect(onDelete).toHaveBeenCalled();
  });

  it('duplica tutti quelli presi', () => {
    const onDuplicate = vi.fn();
    barra(3, { onDuplicate });
    fireEvent.click(screen.getByRole('button', { name: 'Duplica' }));
    expect(onDuplicate).toHaveBeenCalled();
  });

  it('offre di lasciar perdere', () => {
    const onClear = vi.fn();
    barra(3, { onClear });
    fireEvent.click(screen.getByRole('button', { name: 'Deseleziona' }));
    expect(onClear).toHaveBeenCalled();
  });
});
