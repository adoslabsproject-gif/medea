/**
 * Il reset non deve rompere quello che il browser fa già bene.
 *
 * Un `<dialog>` aperto con `showModal()` lo centra il browser da sé, con
 * `margin: auto` nel suo foglio di stile predefinito. L'azzeramento
 * universale `* { margin: 0 }` glielo toglieva, e ogni modale dell'app
 * finiva nell'angolo in alto a sinistra.
 *
 * È il tipo di guasto che nessun test di componente prende — il componente è
 * giusto, è il foglio di stile globale a tradirlo — e che si nota solo
 * aprendo un modale a occhio. Quindi si asserisce sul CSS.
 *
 * Sta qui e non nel pacchetto del design system perché quello è di soli fogli
 * di stile e non ha vitest: aggiungerglielo per una riga costerebbe una
 * dipendenza in più a un pacchetto che non ne ha nessuna.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const reset = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/design-system/src/reset.css'),
  'utf8',
);

/** Il corpo di una regola, cercata per selettore. */
function rule(selector: string): string {
  const match = new RegExp(`(^|\\n)\\s*${selector}\\s*\\{([^}]*)\\}`).exec(reset);
  return match?.[2] ?? '';
}

describe('il reset', () => {
  it('azzera i margini su tutto, che è il suo mestiere', () => {
    expect(rule('\\*')).toContain('margin: 0');
  });

  it('ma restituisce a `dialog` il margine che lo centra', () => {
    // Senza questa riga i modali finiscono in alto a sinistra. Tutti e dodici.
    expect(rule('dialog')).toContain('margin: auto');
  });

  it('e la regola su `dialog` viene DOPO quella universale', () => {
    // Stessa specificità non è: `dialog` è più specifico di `*`. Ma se un
    // giorno qualcuno spostasse l'azzeramento più in basso, vincerebbe lui.
    expect(reset.indexOf('dialog {')).toBeGreaterThan(reset.indexOf('margin: 0'));
  });
});
