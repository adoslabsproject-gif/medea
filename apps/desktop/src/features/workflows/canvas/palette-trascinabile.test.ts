/**
 * Il trascinamento sopravvive a WebKit, e questo test lo verifica sul CSS.
 *
 * Il comportamento vive in una regola di stile, non in una riga di codice: in
 * WebKit — la WebView con cui Medea gira sul Mac — il trascinamento nativo
 * parte dalla selezione, quindi `user-select: none` lo spegne e l'attributo
 * `draggable` da solo non lo riaccende. Serve `-webkit-user-drag: element`.
 *
 * È già successo due volte che il trascinamento smettesse di funzionare sul
 * Mac senza che nessuno collegasse la causa all'effetto: la prima perché le
 * voci erano `<button>`, la seconda perché sistemando quello si è aggiunto
 * `user-select: none` senza la riga che lo compensa. Un test che monta il
 * componente non se ne accorge — jsdom non ha il motore di WebKit — quindi si
 * guarda il foglio di stile.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const qui = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(qui, 'NodePalette.module.css'), 'utf8');

/** Il blocco della voce trascinabile, dall'inizio alla graffa che lo chiude. */
function regolaItem(): string {
  const inizio = css.indexOf('.item {');
  expect(inizio, 'la regola .item non esiste più: è stata rinominata?').toBeGreaterThan(-1);
  const fine = css.indexOf('\n  }', inizio);
  return css.slice(inizio, fine);
}

describe('le voci della palette restano trascinabili su WebKit', () => {
  it('🚨 la voce dichiara -webkit-user-drag: element', () => {
    expect(
      regolaItem(),
      'senza questa riga il trascinamento non parte sul Mac, in silenzio',
    ).toMatch(/-webkit-user-drag:\s*element/);
  });

  it('🚨 se c’è user-select: none, c’è anche la riga che lo compensa', () => {
    const item = regolaItem();
    if (!/user-select:\s*none/.test(item)) return;
    expect(
      item,
      'user-select: none spegne il trascinamento in WebKit: serve -webkit-user-drag',
    ).toMatch(/-webkit-user-drag:\s*element/);
  });
});
