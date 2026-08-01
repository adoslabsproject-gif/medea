/**
 * Nessun token inventato.
 *
 * Uno sfondo che punta a un token non definito da nessuna parte non è un
 * errore: il browser butta la dichiarazione e va avanti. Il pulsante resta lì,
 * leggibile, solo senza sfondo — e la differenza fra un primario e un
 * secondario sparisce senza che niente si lamenti.
 *
 * È successo davvero: `--color-accent-solid` e `--color-accent-on-solid` non
 * sono mai esistiti — i nomi giusti sono `--color-accent-default` e
 * `--color-accent-on` — ed erano usati **41 volte** nell'editor dei workflow.
 * Tutti i pulsanti primari. Nessuno se n'era accorto perché l'app continuava a
 * funzionare.
 *
 * Qui si raccoglie ogni riferimento senza ripiego e si controlla che quel
 * nome esista da qualche parte: nei token generati, nel design system, o
 * definito nel file stesso. Un riferimento che porta con sé un ripiego dopo
 * la virgola è invece una scelta consapevole, e passa.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RADICE = join(import.meta.dirname, '..', '..', '..');
const DA_GUARDARE = [
  join(RADICE, 'apps', 'desktop', 'src'),
  join(RADICE, 'packages', 'design-system', 'src'),
];
const DEFINIZIONI = [
  ...DA_GUARDARE,
  join(RADICE, 'packages', 'design-system', 'dist'),
  join(RADICE, 'packages', 'design-system', 'tokens'),
];

/** I file che possono contenere CSS: i moduli, e i pochi stili scritti in TS. */
const ESTENSIONI = ['.css', '.ts', '.tsx'];

function* filesIn(dir: string): Generator<string> {
  let voci: string[];
  try {
    voci = readdirSync(dir);
  } catch {
    return;
  }
  for (const voce of voci) {
    if (voce === 'node_modules' || voce === 'dist' || voce.startsWith('.')) continue;
    const percorso = join(dir, voce);
    if (statSync(percorso).isDirectory()) {
      yield* filesIn(percorso);
    } else if (ESTENSIONI.some((e) => voce.endsWith(e))) {
      yield percorso;
    }
  }
}

/** Un riferimento senza ripiego: la virgola direbbe che c'è un piano B. */
const USO_SENZA_RIPIEGO = /var\(\s*(--[\w-]+)\s*\)/g;
const DEFINIZIONE = /(--[\w-]+)\s*:/g;

/** I nomi che qualcuno definisce, ovunque nel progetto. */
function definiti(): Set<string> {
  const nomi = new Set<string>();
  for (const dir of DEFINIZIONI) {
    for (const file of filesIn(dir)) {
      const testo = readFileSync(file, 'utf8');
      for (const m of testo.matchAll(DEFINIZIONE)) if (m[1]) nomi.add(m[1]);
    }
  }
  // I token generati stanno anche in `dist/tokens.css`, che filesIn salta
  // perché salta le cartelle `dist`. Si legge a parte.
  try {
    const generati = readFileSync(
      join(RADICE, 'packages', 'design-system', 'dist', 'tokens.css'),
      'utf8',
    );
    for (const m of generati.matchAll(DEFINIZIONE)) if (m[1]) nomi.add(m[1]);
  } catch {
    // Senza `pnpm tokens:build` il file non c'è: il test lo dirà da sé,
    // segnalando come mancanti tutti i token semantici insieme.
  }
  return nomi;
}

/** Le proprietà di xyflow: le definisce la sua libreria, non noi. */
const VENDOR = /^--(xy|rf|reactflow|cm)-/;

describe('i token del design system', () => {
  it('esistono tutti quelli che si usano', () => {
    const noti = definiti();
    const inventati: string[] = [];

    for (const dir of DA_GUARDARE) {
      for (const file of filesIn(dir)) {
        const testo = readFileSync(file, 'utf8');
        for (const m of testo.matchAll(USO_SENZA_RIPIEGO)) {
          const nome = m[1];
          if (!nome || noti.has(nome) || VENDOR.test(nome)) continue;
          inventati.push(`${file.slice(RADICE.length + 1)} → ${nome}`);
        }
      }
    }

    // La lista intera, non il primo: se se ne aggiungono tre si vogliono
    // vedere tutti e tre, non uno alla volta per tre giri.
    expect([...new Set(inventati)].sort()).toEqual([]);
  });
});
