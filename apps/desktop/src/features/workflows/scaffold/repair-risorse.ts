/**
 * I campi che indicano una risorsa dell'utente: quale database, quale account.
 *
 * Il modello non può conoscerli. L'id del tuo database e quello del tuo
 * account di posta non stanno in nessun catalogo e non si deducono
 * dall'obiettivo: sono cose che esistono solo sul tuo computer. Chiedendogli
 * un workflow, però, il campo lo riempie lo stesso — con quello che ha sotto
 * gli occhi. Nel catalogo legge `databaseId:db-picker(REQUIRED)`, e scrive
 * `db-picker`: ha copiato il *tipo* del campo credendolo un valore.
 *
 * La riparazione per questo caso c'era già, e copriva metà del problema:
 *
 *     } else if (missing && field.required && isPickerField(field.type)) {
 *       node.config[field.key] = PICKER_PLACEHOLDER;
 *
 * Vale solo se il campo è **mancante**. Riempito di spazzatura non è mancante,
 * quindi passava — e più avanti il controllo di qualità lo bocciava con
 * gravità critica. Critico vuol dire «riprovando può andare meglio», e qui
 * riprovare non serviva a niente: alla seconda e alla terza generazione il
 * modello continuava a non sapere quale fosse il tuo database. Il 2026-08-04
 * questo ha consumato tre generazioni complete, oltre cinque minuti, per
 * finire con un errore che nessun tentativo poteva evitare.
 *
 * Quali campi siano dell'utente non si indovina dal nome: lo dice il catalogo,
 * col tipo del campo (`db-picker`, `account-picker`, …). `isPickerField` lo
 * sa già, e usare quello invece di una regex sui nomi evita di sbagliare in
 * entrambe le direzioni.
 *
 * @module features/workflows/scaffold/repair-risorse
 */

import { PENDING_SECRET } from '../constants';
import type { NodeDef } from '../types';

import type { RepairLog } from './repair';
import type { ScaffoldOutput } from './schema';
import { isPickerField, PICKER_PLACEHOLDER } from './validate';

/**
 * Vero solo per ciò che è palesemente copiato dal catalogo.
 *
 * Il criterio è deliberatamente stretto. «Tutto quello che non sembra un id
 * vero» sarebbe stato più facile da scrivere e avrebbe fatto danni: su un
 * `timezone-picker` il modello può benissimo azzeccare `Europe/Rome`, che non
 * somiglia affatto a un UUID — cancellarlo significherebbe sostituire una
 * risposta giusta con un campo da riempire a mano.
 *
 * Quello che si riconosce con certezza è la copiatura: il valore coincide col
 * nome del tipo, o comunque finisce per `-picker`, che nessuna risorsa vera fa.
 */
function copiatoDalCatalogo(valore: unknown, tipoCampo: string): boolean {
  if (typeof valore !== 'string' || valore.length === 0) return false;
  // Le espressioni si risolvono quando il workflow gira: non sono inventate.
  if (valore.includes('{{') || valore.includes('$node.') || valore.includes('secrets.')) {
    return false;
  }
  if (valore === PICKER_PLACEHOLDER) return false;
  return valore === tipoCampo || valore.endsWith('-picker');
}

/**
 * Rimpiazza col segnaposto del menu gli id di risorsa che il modello si è
 * inventato, e torna quanti campi ha toccato.
 *
 * Il numero serve: «pronto, tranne due cose da scegliere» è un esito diverso
 * da «pronto», e va detto.
 */
export function riparaIdRisorse(
  output: ScaffoldOutput,
  catalog: Map<string, NodeDef>,
  log: RepairLog,
): number {
  let toccati = 0;
  for (const node of output.nodes) {
    const def = catalog.get(node.defId);
    if (!def?.configFields) continue;

    for (const field of def.configFields) {
      const valore = node.config[field.key];

      if (isPickerField(field.type)) {
        if (!copiatoDalCatalogo(valore, field.type)) continue;
        node.config[field.key] = PICKER_PLACEHOLDER;
        toccati += 1;
        log.applied.push(
          `${node.id}.${field.key}: "${String(valore)}" non è un identificativo reale, lo sceglierai dal menu.`,
        );
        continue;
      }

      // Un segreto obbligatorio e mancante è la stessa storia degli id: la
      // password della tua PEC non sta in nessun catalogo, e chiederla al
      // modello altre due volte non la fa comparire. Il 2026-08-04 questo
      // bocciava il workflow «archivia le PEC» per `username` e `password`,
      // cioè per le uniche due cose che il modello non poteva sapere.
      //
      // `__pending__` è il marcatore che il motore già conosce: dice «questo
      // lo configuri prima di attivare», e il controllo di qualità lo accetta.
      if (field.type === 'secret' && field.required && vuoto(valore)) {
        node.config[field.key] = PENDING_SECRET;
        toccati += 1;
        log.applied.push(`${node.id}.${field.key}: da configurare prima di attivare.`);
      }
    }
  }
  return toccati;
}

function vuoto(valore: unknown): boolean {
  return valore === undefined || valore === null || valore === '';
}
