/**
 * Costanti condivise da tutta la feature workflows.
 *
 * Stanno qui, e non dentro uno dei moduli che le usano, perché sia la
 * validazione strutturale sia il quality gate devono riconoscere gli stessi
 * valori: se divergessero, un workflow risulterebbe valido per uno e rotto
 * per l'altro.
 */

/**
 * Il valore che marca un campo che l'utente sceglierà da un menu prima di
 * importare (un database, un account email, una credenziale). Non è un
 * segnaposto inventato dal modello: è un impegno esplicito a chiedere il
 * valore all'utente, quindi nessun controllo deve trattarlo come un errore.
 */
export const PICKER_PLACEHOLDER = '__USE_PICKER__';

/** Il marcatore usato dal server per un segreto ancora da configurare. */
export const PENDING_SECRET = '__pending__';
