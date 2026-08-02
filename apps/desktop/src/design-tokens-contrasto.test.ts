/**
 * Il testo si deve leggere — misurato, non a occhio.
 *
 * I colori si possono ammorbidire quanto si vuole finché restano leggibili, e
 * dove finisca il «quanto si vuole» non lo dice l'impressione di chi guarda:
 * lo dice il rapporto di contrasto. Il 2026-08-03 la palette è stata resa più
 * riposante — fondo chiaro meno abbagliante, fondo scuro meno nero — ed è
 * esattamente il genere di modifica che può scendere sotto la soglia senza che
 * nessuno se ne accorga finché qualcuno non fatica a leggere.
 *
 * Le soglie sono quelle di WCAG 2.1: 4.5:1 per il testo normale, 3:1 per il
 * testo grande e per i bordi che veicolano informazione.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Dalla cartella di questo file alla radice del workspace. */
const radice = join(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Palette {
  primitives: Record<string, Record<string, string>>;
  semantic: Record<string, Record<string, { light: string; dark: string }>>;
}

const palette = JSON.parse(
  readFileSync(join(radice, 'packages/design-system/tokens/color.json'), 'utf8'),
) as unknown as Palette;

/** Scioglie un riferimento `{primitives.slate.900}` nel suo valore OKLCH. */
function risolvi(riferimento: string): string {
  const percorso = /^\{(.+)\}$/.exec(riferimento)?.[1];
  if (!percorso) return riferimento;
  const [gruppo, famiglia, grado] = percorso.split('.');
  const valore = palette.primitives[famiglia ?? '']?.[grado ?? ''];
  if (!valore) throw new Error(`riferimento non risolto: ${riferimento} (${gruppo ?? ''})`);
  return valore;
}

/** I tre numeri dentro `oklch(L C H)`. */
function leggiOklch(valore: string): [number, number, number] {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(valore);
  if (!m) throw new Error(`non è un colore OKLCH: ${valore}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Da OKLCH a sRGB lineare, passando per OKLab (Björn Ottosson). */
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

/** Luminanza relativa secondo WCAG. */
function luminanza(valore: string): number {
  const [r, g, b] = versoLineare(leggiOklch(valore));
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/** Il rapporto di contrasto fra due colori, da 1:1 a 21:1. */
function contrasto(primo: string, secondo: string): number {
  const a = luminanza(risolvi(primo));
  const b = luminanza(risolvi(secondo));
  const [chiaro, scuro] = a > b ? [a, b] : [b, a];
  return (chiaro + 0.05) / (scuro + 0.05);
}

/** Il valore di un token semantico in uno dei due temi. */
function token(nome: string, tema: 'light' | 'dark'): string {
  const [gruppo, variante] = nome.split('.');
  const coppia = palette.semantic[gruppo ?? '']?.[variante ?? ''];
  if (!coppia) throw new Error(`token semantico assente: ${nome}`);
  return coppia[tema];
}

/** Le combinazioni che compaiono davvero a schermo. */
const COPPIE: { testo: string; fondo: string; minimo: number; descrizione: string }[] = [
  { testo: 'text.primary', fondo: 'surface.1', minimo: 4.5, descrizione: 'testo principale' },
  { testo: 'text.primary', fondo: 'surface.2', minimo: 4.5, descrizione: 'testo su pannello' },
  { testo: 'text.secondary', fondo: 'surface.1', minimo: 4.5, descrizione: 'testo secondario' },
  {
    testo: 'text.secondary',
    fondo: 'surface.2',
    minimo: 4.5,
    descrizione: 'secondario su pannello',
  },
  // I testi attenuati sono etichette e note: soglia da testo grande.
  { testo: 'text.muted', fondo: 'surface.1', minimo: 3, descrizione: 'testo attenuato' },
  { testo: 'text.muted', fondo: 'surface.2', minimo: 3, descrizione: 'attenuato su pannello' },
  { testo: 'accent.on', fondo: 'accent.default', minimo: 4.5, descrizione: 'testo sul pulsante' },
];

describe('il testo resta leggibile', () => {
  for (const tema of ['light', 'dark'] as const) {
    describe(tema === 'light' ? 'tema chiaro' : 'tema scuro', () => {
      for (const { testo, fondo, minimo, descrizione } of COPPIE) {
        it(`🚨 ${descrizione}: almeno ${minimo}:1`, () => {
          const rapporto = contrasto(token(testo, tema), token(fondo, tema));
          expect(
            Number(rapporto.toFixed(2)),
            `${testo} su ${fondo} nel tema ${tema}: ${rapporto.toFixed(2)}:1, sotto ${minimo}:1`,
          ).toBeGreaterThanOrEqual(minimo);
        });
      }
    });
  }

  it('i bordi si distinguono dal fondo su cui stanno', () => {
    for (const tema of ['light', 'dark'] as const) {
      const rapporto = contrasto(token('border.strong', tema), token('surface.1', tema));
      expect(rapporto, `bordo forte nel tema ${tema}`).toBeGreaterThanOrEqual(1.5);
    }
  });
});
