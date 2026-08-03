/**
 * La ricerca deve proporre il nodo giusto, non quello che parla di più.
 *
 * Il 2026-08-03, alla richiesta «ogni domenica archivia le newsletter più
 * vecchie di trenta giorni», l'agente ha costruito un workflow con dentro un
 * nodo PEC. Non era una stranezza del modello: la ricerca gliel'aveva messo in
 * cima, perché *PEC: Archiviazione a Norma* nella descrizione contiene
 * «archivia», «email» e «conserva», e il punteggio contava le parole ovunque
 * comparissero senza distinguere il nome dal resto.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import type { NodeDef } from '../types';

import { ordinaPerPertinenza, punteggio, termini } from './punteggio';

function nodo(defId: string, label: string, description: string, aliases?: string[]): NodeDef {
  return {
    defId,
    label,
    description,
    type: 'action',
    ...(aliases ? { searchAliases: aliases } : {}),
  };
}

/** Due nodi che si contendono la stessa ricerca, come nel catalogo vero. */
const PEC = nodo(
  'action_pec_legal_archive',
  'PEC: Archiviazione a Norma',
  'Conserva e archivia i messaggi di posta elettronica certificata a norma di legge, con marca temporale.',
);
const ARCHIVIA = nodo(
  'action_email_archive',
  'Email: archivia',
  'Sposta i messaggi in una cartella di archivio.',
);

describe('il punteggio di pertinenza', () => {
  it('🚨 il nome pesa più della descrizione', () => {
    const t = termini('archivia email');
    expect(punteggio(ARCHIVIA, t)).toBeGreaterThan(punteggio(PEC, t));
  });

  it('🚨 chi cerca di archiviare email non si vede proporre la PEC per prima', () => {
    const risultati = ordinaPerPertinenza([PEC, ARCHIVIA], 'archivia le email vecchie', 5);
    expect(risultati[0]?.defId).toBe('action_email_archive');
  });

  it('un alias che combacia in pieno vale quanto il nome', () => {
    const wa = nodo('action_whatsapp_send', 'WhatsApp', 'manda un messaggio', ['wa']);
    const altro = nodo('action_http', 'Chiamata HTTP', 'wa non c’entra ma la parola c’è');
    const t = termini('wa');
    expect(punteggio(wa, t)).toBeGreaterThan(punteggio(altro, t));
  });

  it('chi non corrisponde resta fuori', () => {
    expect(ordinaPerPertinenza([PEC, ARCHIVIA], 'kafka rabbitmq', 5)).toEqual([]);
  });

  it('una ricerca vuota restituisce il catalogo, non niente', () => {
    expect(ordinaPerPertinenza([PEC, ARCHIVIA], '   ', 5)).toHaveLength(2);
  });

  it('le sillabe troppo corte non contano: sarebbero in ogni nodo', () => {
    expect(termini('di e la email')).toEqual(['di', 'la', 'email']);
  });
});
