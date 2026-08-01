// @vitest-environment happy-dom

/**
 * L'editor di codice, montato davvero.
 *
 * CodeMirror lavora sul DOM: se qualcosa non gli va — un'estensione che non
 * esiste, un tema malformato — non fallisce a compilazione, esplode
 * all'apertura del pannello. Ed è il pannello che si apre più spesso.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './CodeEditor';

afterEach(cleanup);

describe('l’editor di codice', () => {
  it('si monta e mostra quello che gli si dà', () => {
    const { container } = render(
      <CodeEditor value="return { a: 1 };" language="javascript" onChange={vi.fn()} />,
    );
    expect(container.textContent).toContain('return');
  });

  it('funziona per ognuna delle lingue che il catalogo dichiara', () => {
    // Le sei che i nodi possono dichiarare. Tre non hanno un supporto e
    // restano senza colore: devono comunque montarsi.
    for (const language of ['javascript', 'typescript', 'json', 'sql', 'yaml', 'jsonata']) {
      cleanup();
      const { container } = render(<CodeEditor value="x" language={language} onChange={vi.fn()} />);
      expect(container.querySelector('.cm-editor'), language).toBeTruthy();
    }
  });

  it('si monta anche senza lingua dichiarata', () => {
    // Succede su tre campi su quarantaquattro.
    const { container } = render(<CodeEditor value="niente" onChange={vi.fn()} />);
    expect(container.querySelector('.cm-editor')).toBeTruthy();
  });

  it('mostra i numeri di riga: senza, un errore «alla riga 12» non si trova', () => {
    const { container } = render(
      <CodeEditor value={'a\nb\nc'} language="javascript" onChange={vi.fn()} />,
    );
    expect(container.querySelector('.cm-gutters')).toBeTruthy();
  });

  it('un valore che cambia da fuori si allinea', () => {
    // Capita con un annulla o riaprendo un workflow.
    const { container, rerender } = render(<CodeEditor value="prima" onChange={vi.fn()} />);
    rerender(<CodeEditor value="dopo" onChange={vi.fn()} />);
    expect(container.textContent).toContain('dopo');
    expect(container.textContent).not.toContain('prima');
  });
});
