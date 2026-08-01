// @vitest-environment happy-dom

/**
 * La palette dei nodi.
 *
 * Un test solo conta davvero, ed è il primo: le voci **non** devono essere
 * `<button>`. WebKit — la WebView di sistema con cui Medea gira sul Mac — non
 * avvia il trascinamento sui controlli di modulo, e con un `<button>` il nodo
 * non si lascia prendere. Senza errori, senza segni: non succede niente.
 *
 * Gli altri fissano quello che il `<button>` dava e che non si deve perdere
 * cambiando elemento: si raggiunge col Tab, si attiva con Invio e con la barra
 * spaziatrice.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodePalette } from './NodePalette';

afterEach(cleanup);

/** La prima voce della palette, qualunque nodo sia. */
function primaVoce(): HTMLElement {
  const voci = screen.getAllByRole('button');
  const voce = voci.find((v) => v.getAttribute('draggable') === 'true');
  if (!voce) throw new Error('nessuna voce trascinabile nella palette');
  return voce;
}

describe('le voci della palette', () => {
  it('non sono <button>, o su macOS non si trascinano', () => {
    render(<NodePalette onAdd={vi.fn()} />);
    const voce = primaVoce();
    // Il punto di tutto il file. Se qualcuno rimette un <button> perché «è
    // più corretto semanticamente», il trascinamento smette di funzionare
    // sul Mac e nessuno collega le due cose.
    expect(voce.tagName).not.toBe('BUTTON');
    expect(voce.getAttribute('role')).toBe('button');
  });

  it('si raggiungono col Tab', () => {
    render(<NodePalette onAdd={vi.fn()} />);
    expect(primaVoce().getAttribute('tabindex')).toBe('0');
  });

  it('si aggiungono col click', () => {
    const onAdd = vi.fn();
    render(<NodePalette onAdd={onAdd} />);
    fireEvent.click(primaVoce());
    expect(onAdd).toHaveBeenCalled();
  });

  it('e da tastiera, con Invio e con la barra', () => {
    const onAdd = vi.fn();
    render(<NodePalette onAdd={onAdd} />);
    fireEvent.keyDown(primaVoce(), { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(primaVoce(), { key: ' ' });
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it('portano con sé il nodo quando si trascinano', () => {
    render(<NodePalette onAdd={vi.fn()} />);
    const scritti = new Map<string, string>();
    fireEvent.dragStart(primaVoce(), {
      dataTransfer: {
        setData: (t: string, v: string) => scritti.set(t, v),
        effectAllowed: '',
      },
    });
    // Entrambe le forme: quella propria e `text/plain`, che è l'unica che
    // WebKit consegna davvero.
    expect(scritti.get('text/plain')).toMatch(/^medea-node:/);
    expect(scritti.get('application/medea-node')).toBeTruthy();
  });
});
