/**
 * Esempi da cui partire.
 *
 * Una casella di testo vuota è la peggior domanda che si possa fare: chi non
 * sa cosa il sistema è capace di fare non sa nemmeno cosa chiedergli. Gli
 * esempi non sono decorazione, sono il modo in cui si impara il confine di
 * quello che si può ottenere.
 *
 * Sono tutti centrati sulla posta: è quello che Medea sa fare meglio, ed è
 * dove un'automazione toglie davvero carico invece di aggiungerne.
 */

export interface WizardExample {
  title: string;
  goal: string;
}

export const WIZARD_EXAMPLES: readonly WizardExample[] = [
  {
    title: 'Riepilogo del mattino',
    goal: 'Ogni mattina alle 8 raccogli le email non lette arrivate nelle ultime 24 ore, riassumile per punti e mandami il riepilogo per posta.',
  },
  {
    title: 'Allegati al loro posto',
    goal: 'Quando arriva una email con un allegato PDF da un mittente della mia rubrica, salva il file in una cartella e segna il messaggio come letto.',
  },
  {
    title: 'Chi aspetta una risposta',
    goal: 'Ogni venerdì trova le email a cui non ho risposto da più di tre giorni e mandami l’elenco con mittente e oggetto.',
  },
  {
    title: 'Fatture verso il foglio',
    goal: 'Quando arriva una email con oggetto che contiene "fattura", estrai numero, importo e scadenza e aggiungi una riga a una tabella.',
  },
  {
    title: 'Avviso su parole chiave',
    goal: 'Se arriva una email che contiene la parola "urgente" o "scadenza", mandami una notifica immediata con il testo del messaggio.',
  },
  {
    title: 'Pulizia settimanale',
    goal: 'Ogni domenica sera archivia le newsletter più vecchie di trenta giorni e dimmi quante ne hai spostate.',
  },
];
