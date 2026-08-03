/**
 * I nodi che consegnano fuori devono essere riconosciuti come punti d'arrivo.
 *
 * Chi non è nella lista dei terminali e non ha collegamenti in uscita viene
 * segnalato come «ramo morto». Su un nodo che per natura *è* la fine — manda
 * una PEC, scrive un file, archivia a norma — quella segnalazione è un falso
 * allarme, e i falsi allarmi qui costano più che altrove: l'agente che
 * costruisce i workflow li legge come errori da correggere, prova a rimediare
 * a qualcosa che è già giusto, e consuma i suoi passi senza arrivare in fondo.
 *
 * È successo il 2026-08-03 con `action_pec_legal_archive`: quaranta passi
 * bruciati su un workflow che era corretto dal terzo.
 *
 * Il catalogo cresce, la lista no — se nessuno la guarda. Questo test la
 * guarda: pesca dal catalogo i nodi il cui nome dice che consegnano qualcosa
 * fuori, e pretende che siano riconosciuti.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const qui = dirname(fileURLToPath(import.meta.url));

/** I `defId` dichiarati terminali dal controllo di qualità. */
function terminaliDichiarati(): Set<string> {
  // I commenti vanno via per primi: sono in italiano, e un apostrofo dentro
  // «l'archiviazione» si legge come l'inizio di una stringa.
  const codice = readFileSync(join(qui, 'rules-graph.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const blocco = /KNOWN_SINKS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(codice);
  expect(blocco, 'KNOWN_SINKS non trovato: è stato rinominato?').toBeTruthy();
  return new Set([...blocco![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

/** Tutti i `defId` del catalogo dei nodi. */
function catalogo(): string[] {
  const grezzo = JSON.parse(
    readFileSync(join(qui, '../catalog/stdlib-nodes.json'), 'utf8'),
  ) as unknown;
  const nodi = Array.isArray(grezzo) ? grezzo : ((grezzo as { nodes?: unknown[] }).nodes ?? []);
  return (nodi as { defId?: string }[]).map((n) => n.defId ?? '').filter(Boolean);
}

/**
 * I nomi che dicono «questo consegna fuori»: invia, scrive, archivia,
 * risponde. Non è un'euristica perfetta ed è di proposito conservativa —
 * meglio pretendere qualche nodo in più nella lista che lasciarne fuori uno
 * che poi manda l'agente a sbattere.
 */
const CONSEGNA_FUORI =
  /(_send$|_send_|_write$|_archive$|_respond$|_upload$|_insert$|_insert_batch$|_update_activity$)/;

describe('i nodi che consegnano fuori sono punti d’arrivo', () => {
  it('🚨 nessuno di loro viene scambiato per un ramo morto', () => {
    const dichiarati = terminaliDichiarati();
    const mancanti = catalogo()
      .filter((defId) => CONSEGNA_FUORI.test(defId))
      .filter((defId) => !dichiarati.has(defId));

    expect(
      mancanti,
      'questi nodi finiscono un ramo per natura ma non sono in KNOWN_SINKS: ' +
        'verranno segnalati come rami morti, e l’agente sprecherà i suoi passi ' +
        `a «correggerli» — ${mancanti.join(', ')}`,
    ).toEqual([]);
  });

  it('la lista non contiene nodi che nel catalogo non esistono più', () => {
    const esistenti = new Set(catalogo());
    // I nodi della community arrivano da pacchetti installati a parte: non
    // stanno nel catalogo di base e non vanno pretesi qui.
    const stantii = [...terminaliDichiarati()].filter(
      (defId) => !esistenti.has(defId) && !defId.startsWith('community_'),
    );
    expect(stantii, `terminali dichiarati ma non più nel catalogo: ${stantii.join(', ')}`).toEqual(
      [],
    );
  });
});
