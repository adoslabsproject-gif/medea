import { describe, it, expect } from 'vitest';
import { STUDIO_PAGE_HTML } from './page.js';
import { fitToModel } from './fit-dims.js';

/**
 * Guard anti-drift: il pannello /studio promette di "leggere il formato del file
 * e tarare i campi". Quel comportamento dipende dall'iniezione di `fitToModel`
 * (SSOT in fit-dims.ts) nello script client. Questi test ASSERISCONO che
 * l'iniezione e i controlli esistano davvero — se la pagina smette di iniettare
 * la funzione, o un refactor la rinomina, il guard diventa rosso.
 */
describe('STUDIO_PAGE_HTML — auto-formato file caricati (client = server)', () => {
  it('inietta la funzione fitToModel del modulo VERBATIM (nessun drift client/server)', () => {
    // MUTATION: rimuovere `${fitToModel.toString()}` dal template → rosso.
    expect(STUDIO_PAGE_HTML).toContain('const fitToModel = ' + fitToModel.toString());
  });

  it('la funzione è eseguibile lato client e dà gli stessi risultati del server', () => {
    // Ricostruisce la funzione esattamente come fa il browser (eval dello script).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- ricostruisce ciò che il browser eseguirà dal sorgente iniettato
    const injected = new Function(`return (${fitToModel.toString()})`)() as typeof fitToModel;
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [1000, 1000],
      [0, 0],
    ]) {
      expect(injected(w!, h!)).toEqual(fitToModel(w!, h!));
    }
  });

  it('espone il selettore velocità (slow-mo) con le 4 opzioni', () => {
    expect(STUDIO_PAGE_HTML).toContain('id="vslowmo"');
    for (const v of ['value="1"', 'value="2"', 'value="3"', 'value="4"']) {
      expect(STUDIO_PAGE_HTML).toContain(v);
    }
  });

  it('cabla i lettori dimensionati su foto i2v (vrefimg) e video da estendere (vextsrc)', () => {
    expect(STUDIO_PAGE_HTML).toContain("readImgSized($('vrefimg')");
    expect(STUDIO_PAGE_HTML).toContain("readVideoSized($('vextsrc')");
  });

  it('applyVideoFit scrive i campi w/h del pannello (auto-taratura visibile)', () => {
    expect(STUDIO_PAGE_HTML).toContain('applyVideoFit');
    expect(STUDIO_PAGE_HTML).toMatch(/\$\('vw'\)\.value\s*=\s*fit\.width/);
    expect(STUDIO_PAGE_HTML).toMatch(/\$\('vh'\)\.value\s*=\s*fit\.height/);
  });
});
