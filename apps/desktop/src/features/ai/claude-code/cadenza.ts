/**
 * Chiamare una funzione al più ogni tanto, sempre con l'ultimo valore.
 *
 * Il testo di un turno arriva a decine di pezzi al secondo. Ridisegnare e
 * salvare la conversazione a ogni pezzo terrebbe occupata la finestra proprio
 * mentre l'utente guarda scorrere la risposta.
 */
export function cadenzato<T>(
  funzione: (valore: T) => void,
  intervalloMs: number,
): (valore: T) => void {
  let ultimaChiamata = 0;
  let inAttesa: ReturnType<typeof setTimeout> | null = null;
  let ultimoValore: T;

  return (valore) => {
    ultimoValore = valore;
    const trascorso = Date.now() - ultimaChiamata;
    if (trascorso >= intervalloMs) {
      ultimaChiamata = Date.now();
      funzione(valore);
      return;
    }
    // L'ultimo pezzo non va perso: se ne arriva uno a ridosso del precedente
    // lo si mostra appena scade l'intervallo.
    inAttesa ??= setTimeout(() => {
      inAttesa = null;
      ultimaChiamata = Date.now();
      funzione(ultimoValore);
    }, intervalloMs - trascorso);
  };
}
