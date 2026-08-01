/**
 * Il trasporto di un nodo dalla palette al disegno.
 *
 * Il caso che conta è il terzo: una WebView che, come Safari, accetta i tipi
 * MIME propri e poi li consegna vuoti. È quello che rendeva impossibile
 * trascinare un nodo su macOS — senza un errore, senza un segno: si lasciava
 * il nodo e non succedeva niente.
 */

import { describe, expect, it } from 'vitest';

import { draggedNode, setDraggedNode } from './drag-node';

/**
 * Un `DataTransfer` finto, con una manopola per riprodurre WebKit.
 *
 * `ignora` è l'insieme dei tipi che questo trasporto accetta e poi butta:
 * è esattamente ciò che fa Safari con i tipi diversi da `text/plain`,
 * `text/uri-list` e `text/html`.
 */
function trasporto(ignora: readonly string[] = []): DataTransfer {
  const dati = new Map<string, string>();
  return {
    effectAllowed: 'none',
    setData(type: string, value: string) {
      if (ignora.includes(type)) return;
      dati.set(type, value);
    },
    getData(type: string) {
      return dati.get(type) ?? '';
    },
  } as unknown as DataTransfer;
}

describe('trascinare un nodo', () => {
  it('arriva dall’altra parte', () => {
    const dt = trasporto();
    setDraggedNode(dt, 'action_http');
    expect(draggedNode(dt)).toBe('action_http');
  });

  it('dichiara che è una copia, non uno spostamento', () => {
    // Senza, il puntatore mostra il simbolo del divieto sopra il disegno e
    // sembra che lì non si possa lasciare niente.
    const dt = trasporto();
    setDraggedNode(dt, 'action_http');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('arriva anche dove i tipi propri vengono buttati — cioè su macOS', () => {
    // Il caso vero: WebKit accetta `application/medea-node` e lo consegna
    // vuoto. Se resta solo quello, il nodo non si può trascinare.
    const dt = trasporto(['application/medea-node']);
    setDraggedNode(dt, 'trigger_cron');
    expect(draggedNode(dt)).toBe('trigger_cron');
  });

  it('non scambia per un nodo del testo che arriva da fuori', () => {
    // Trascinare una parola da un'altra finestra non deve creare niente.
    const dt = trasporto();
    dt.setData('text/plain', 'ciao');
    expect(draggedNode(dt)).toBeNull();
  });

  it('né un trasporto vuoto', () => {
    expect(draggedNode(trasporto())).toBeNull();
  });

  it('e regge un defId che contiene i due punti', () => {
    // Oggi nessun nodo si chiama così, ma il prefisso si taglia per lunghezza
    // e non fino al primo `:`: se domani succedesse, non si romperebbe.
    const dt = trasporto(['application/medea-node']);
    setDraggedNode(dt, 'community:mio_nodo');
    expect(draggedNode(dt)).toBe('community:mio_nodo');
  });
});
