/**
 * Un nodo a cui manca quello che gli serve per partire.
 *
 * È il controllo che mancava, ed era il più importante di tutti: le altre
 * regole guardano la forma del disegno — chi è collegato a chi, se ci sono
 * cicli, se un ramo finisce nel vuoto — e nessuna guardava se i nodi hanno i
 * dati per funzionare.
 *
 * Il 2026-08-04 un workflow con un trigger IMAP **senza casella e senza
 * cartella** ha ricevuto il verdetto «Tutto a posto: può essere attivato».
 * Non poteva partire in nessun caso: non sapeva cosa guardare. Un controllo
 * che approva ciò che non può funzionare è peggio di nessun controllo, perché
 * sposta la scoperta del guasto a quando il workflow doveva già aver girato.
 *
 * Il campo obbligatorio lo dichiara il nodo stesso (`configFields[].required`):
 * non c'è niente da indovinare, basta guardare.
 *
 * @module features/workflows/quality/rules-campi
 */

import type { QualityGateInput, QualityIssue } from './types';

/**
 * Un valore che c'è ma non vale: stringa vuota, spazi, lista vuota.
 *
 * Un campo obbligatorio riempito con `""` è compilato solo per il compilatore.
 */
function vuoto(valore: unknown): boolean {
  if (valore === undefined || valore === null) return true;
  if (typeof valore === 'string') return valore.trim() === '';
  if (Array.isArray(valore)) return valore.length === 0;
  return false;
}

export function checkCampiObbligatori(input: QualityGateInput): QualityIssue[] {
  const problemi: QualityIssue[] = [];

  for (const nodo of input.nodes) {
    const def = input.defs?.get(nodo.defId);
    // Di un nodo che non conosciamo non sappiamo cosa pretenda: tacere è più
    // onesto che inventarsi un obbligo.
    if (!def?.configFields) continue;

    const config = nodo.config ?? {};
    const mancanti = def.configFields
      .filter((campo) => campo.required && vuoto(config[campo.key]))
      .map((campo) => campo.label ?? campo.key);

    if (mancanti.length === 0) continue;

    // Su un trigger è critico: senza i suoi dati il workflow non parte mai, e
    // attivarlo dà l'illusione che stia in ascolto. Su un'azione è grave ma
    // il flusso almeno comincia, e ci si accorge dell'errore eseguendo.
    const eTrigger = nodo.defId.startsWith('trigger_');
    problemi.push({
      severity: eTrigger ? 'critical' : 'medium',
      code: 'CAMPO_OBBLIGATORIO_VUOTO',
      nodeId: nodo.id,
      message: eTrigger
        ? `Il trigger "${nodo.id}" non ha ${mancanti.join(', ')}: senza, non sa cosa aspettare e il workflow non partirà mai.`
        : `Al nodo "${nodo.id}" manca ${mancanti.join(', ')}: l'esecuzione si fermerà qui.`,
    });
  }

  return problemi;
}
