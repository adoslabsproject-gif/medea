/**
 * Anche i temi nuovi devono restare leggibili.
 *
 * I temi ridefiniscono i colori a mano, uno per uno, dentro un file CSS: è
 * esattamente il posto dove un valore scelto a occhio può finire sotto la
 * soglia senza che nessuno se ne accorga, perché nessuno ricalcola il
 * contrasto mentre sceglie una tonalità che «sta bene».
 *
 * Qui si legge il CSS dei temi, si prendono le variabili che contano e si
 * verifica lo stesso rapporto che si pretende dalla palette predefinita.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const radice = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const temi = ['carta', 'grafite', 'prussia'] as const;

/** Le variabili dichiarate in un tema, per nome. */
function variabili(tema: string): Map<string, string> {
  const css = readFileSync(
    join(radice, `packages/design-system/src/themes/medea-${tema}.css`),
    'utf8',
  );
  const mappa = new Map<string, string>();
  for (const [, nome, valore] of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    mappa.set(nome!, valore!.trim());
  }
  return mappa;
}

function leggiOklch(valore: string): [number, number, number] {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(valore);
  if (!m) throw new Error(`non è un colore OKLCH: ${valore}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Da OKLCH a sRGB lineare, passando per OKLab. */
function versoLineare([L, C, H]: [number, number, number]): [number, number, number] {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function luminanza(valore: string): number {
  const [r, g, b] = versoLineare(leggiOklch(valore));
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function contrasto(primo: string, secondo: string): number {
  const a = luminanza(primo);
  const b = luminanza(secondo);
  const [chiaro, scuro] = a > b ? [a, b] : [b, a];
  return (chiaro + 0.05) / (scuro + 0.05);
}

const COPPIE: { testo: string; fondo: string; minimo: number; descrizione: string }[] = [
  {
    testo: '--color-text-primary',
    fondo: '--color-surface-1',
    minimo: 4.5,
    descrizione: 'testo principale',
  },
  {
    testo: '--color-text-primary',
    fondo: '--color-surface-2',
    minimo: 4.5,
    descrizione: 'testo su pannello',
  },
  {
    testo: '--color-text-secondary',
    fondo: '--color-surface-1',
    minimo: 4.5,
    descrizione: 'testo secondario',
  },
  {
    testo: '--color-text-muted',
    fondo: '--color-surface-1',
    minimo: 3,
    descrizione: 'testo attenuato',
  },
  {
    testo: '--color-accent-on',
    fondo: '--color-accent-default',
    minimo: 4.5,
    descrizione: 'testo sul pulsante',
  },
];

describe.each(temi)('tema «%s»', (tema) => {
  const vars = variabili(tema);

  it('dichiara tutti i colori che servono', () => {
    const mancanti = [...new Set(COPPIE.flatMap((c) => [c.testo, c.fondo]))].filter(
      (nome) => !vars.has(nome),
    );
    expect(mancanti, `variabili non dichiarate: ${mancanti.join(', ')}`).toEqual([]);
  });

  for (const { testo, fondo, minimo, descrizione } of COPPIE) {
    it(`🚨 ${descrizione}: almeno ${minimo}:1`, () => {
      const rapporto = contrasto(vars.get(testo)!, vars.get(fondo)!);
      expect(
        Number(rapporto.toFixed(2)),
        `${testo} su ${fondo}: ${rapporto.toFixed(2)}:1, sotto ${minimo}:1`,
      ).toBeGreaterThanOrEqual(minimo);
    });
  }

  it('dichiara con che schema di colori va letto', () => {
    const css = readFileSync(
      join(radice, `packages/design-system/src/themes/medea-${tema}.css`),
      'utf8',
    );
    // Senza `color-scheme` le parti disegnate dal sistema — barre di
    // scorrimento, campi nativi — restano del tema precedente.
    expect(css).toMatch(/color-scheme:\s*(light|dark)/);
  });
});
