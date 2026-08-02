/**
 * Il rilascio del mouse deve arrivare alla pagina, non fermarsi alla finestra.
 *
 * Tauri, di suo, intercetta il trascinamento a livello di sistema operativo
 * per gestire i file che si lasciano cadere sulla finestra. È utile a chi quei
 * file li vuole ricevere, e devastante per chi no: gli eventi `drop` non
 * arrivano più alla pagina. Dentro il webview `dragstart` e `dragover`
 * continuano a funzionare — il puntatore mostra il segno di aggiunta, tutto
 * sembra a posto — ma il rilascio sparisce nel nulla e non succede niente.
 *
 * È così che il 2026-08-02 i nodi non si lasciavano mettere sulla lavagna:
 * «non viene lasciato sulla lavagna, nonostante il +». Il `+` era proprio il
 * sintomo che confondeva — diceva che il trascinamento funzionava, mentre
 * quello che mancava era l'ultimo passo.
 *
 * Medea non riceve file trascinati dal sistema: non c'è nessun ascoltatore di
 * quegli eventi, né lato pagina né lato Rust. Quindi l'intercettazione non
 * serve a niente e toglie l'unica cosa che serve.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const radice = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface TauriConf {
  app?: { windows?: { label?: string; dragDropEnabled?: boolean }[] };
}

const conf = JSON.parse(
  readFileSync(join(radice, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
) as TauriConf;

describe('il trascinamento arriva alla pagina', () => {
  it('🚨 la finestra principale non intercetta il rilascio', () => {
    const principale = conf.app?.windows?.find((w) => w.label === 'main');
    expect(principale, 'la finestra «main» non esiste più nella configurazione').toBeDefined();
    expect(
      principale?.dragDropEnabled,
      'senza `dragDropEnabled: false` gli eventi `drop` non arrivano alla pagina: ' +
        'si trascina un nodo, compare il segno di aggiunta, e non viene messo niente',
    ).toBe(false);
  });
});
