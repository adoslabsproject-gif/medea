/**
 * Chi tiene un riferimento «sono ancora a schermo» lo deve rimettere a vero.
 *
 * Il modo naturale di scrivere quel riferimento è anche quello sbagliato:
 *
 *     useEffect(() => () => { vivo.current = false; }, []);
 *
 * Il cleanup c'è, il setup no. In sviluppo React monta ogni componente due
 * volte apposta — monta, smonta, rimonta — per far emergere gli effetti che
 * non sanno ripartire. Con il solo cleanup, quel primo smontaggio lascia il
 * riferimento a falso **per sempre**, e da lì ogni `if (!vivo.current) return`
 * scarta il lavoro in silenzio.
 *
 * Il 2026-08-03 questo ha tenuto il wizard su «sta pensando» all'infinito:
 * niente passi, niente errori, e il pulsante «Interrompi» che sembrava rotto
 * perché fermava davvero il lavoro ma nessuno aggiornava più lo schermo.
 *
 * Il guasto non si vede leggendo il file: si vede solo qui.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const qui = dirname(fileURLToPath(import.meta.url));

const SORGENTI = ['useWizard.ts', '../assistant/useWorkflowChat.ts'] as const;

describe('i riferimenti «sono ancora a schermo» sanno ripartire', () => {
  for (const file of SORGENTI) {
    it(`🚨 ${file}: chi azzera il riferimento lo rimette anche a vero`, () => {
      const codice = readFileSync(join(qui, file), 'utf8');

      // I nomi usati nel progetto per questo riferimento.
      for (const nome of ['alive', 'vivo', 'montato']) {
        const azzera = new RegExp(`${nome}\\.current\\s*=\\s*false`).test(codice);
        if (!azzera) continue;
        expect(
          new RegExp(`${nome}\\.current\\s*=\\s*true`).test(codice),
          `«${nome}» viene messo a falso ma mai rimesso a vero: dopo il primo ` +
            'smontaggio ogni aggiornamento verrà scartato in silenzio',
        ).toBe(true);
      }
    });
  }
});
