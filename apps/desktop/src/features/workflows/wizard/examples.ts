/**
 * Esempi da cui partire, divisi per quello che fanno.
 *
 * Una casella di testo vuota è la peggior domanda che si possa fare: chi non
 * sa cosa il sistema è capace di fare non sa nemmeno cosa chiedergli. Gli
 * esempi non sono decorazione, sono il modo in cui si impara il confine di
 * quello che si può ottenere — e le categorie servono a far vedere in un colpo
 * d'occhio che quel confine è molto più largo della posta.
 *
 * Sono scritti come li direbbe una persona, non come li scriverebbe un
 * tecnico: è la forma che l'assistente si aspetta, e vederla insegna più di
 * qualunque istruzione su come formulare la richiesta.
 *
 * Ognuno dice **quando parte**, **cosa fa** e **dove finisce**. Sono le tre
 * cose che servono a costruire un workflow: un esempio che le contiene tutte
 * e tre insegna a scriverle anche quando si chiederà altro.
 *
 * @module features/workflows/wizard/examples
 */

export interface WizardExample {
  title: string;
  goal: string;
}

export interface WizardCategory {
  id: string;
  label: string;
  /** Cosa ci si trova dentro, in poche parole. */
  hint: string;
  icon: string;
  examples: readonly WizardExample[];
}

export const WIZARD_CATEGORIES: readonly WizardCategory[] = [
  {
    id: 'posta',
    label: 'Posta',
    hint: 'Quello che arriva nella casella: smistato, riassunto, archiviato',
    icon: '✉️',
    examples: [
      {
        title: 'Riepilogo del mattino',
        goal: 'Ogni mattina alle 8 raccogli le email non lette arrivate nelle ultime 24 ore, riassumile per punti e mandami il riepilogo per posta.',
      },
      {
        title: 'Chi aspetta una risposta',
        goal: 'Ogni venerdì trova le email a cui non ho risposto da più di tre giorni e mandami l’elenco con mittente e oggetto.',
      },
      {
        title: 'Pulizia settimanale',
        goal: 'Ogni domenica sera archivia le newsletter più vecchie di trenta giorni e dimmi quante ne hai spostate.',
      },
      {
        title: 'Allegati al loro posto',
        goal: 'Quando arriva una email con un allegato PDF da un mittente della mia rubrica, salva il file in una cartella e segna il messaggio come letto.',
      },
      {
        title: 'Fuori orario',
        goal: 'Quando arriva una email dopo le 19 o nel fine settimana, rispondi che la leggerò il primo giorno lavorativo.',
      },
    ],
  },
  {
    id: 'documenti',
    label: 'Documenti e file',
    hint: 'File che arrivano, si leggono, si trasformano',
    icon: '📄',
    examples: [
      {
        title: 'Fatture verso la tabella',
        goal: 'Quando arriva una email con oggetto che contiene "fattura", estrai numero, importo e scadenza e aggiungi una riga a una tabella.',
      },
      {
        title: 'Da Excel al database',
        goal: 'Quando compare un file Excel nella cartella Import, leggilo e inserisci ogni riga nella tabella clienti.',
      },
      {
        title: 'Rapporto in PDF',
        goal: 'Ogni lunedì mattina genera un PDF con i dati della settimana precedente e mandamelo per email.',
      },
    ],
  },
  {
    id: 'archivio',
    label: 'Archivio e dati',
    hint: 'Leggere, scrivere e tenere in ordine le tabelle',
    icon: '🗄️',
    examples: [
      {
        title: 'Copia di sicurezza',
        goal: 'Ogni domenica notte esporta la tabella ordini in un file e salvalo in una cartella di backup.',
      },
      {
        title: 'Scorte sotto controllo',
        goal: 'Ogni mattina controlla quali articoli sono sotto la scorta minima e mandami l’elenco per email.',
      },
      {
        title: 'Pulizia mensile',
        goal: 'Ogni primo del mese cancella dalla tabella log le righe più vecchie di novanta giorni e dimmi quante ne hai tolte.',
      },
    ],
  },
  {
    id: 'italia',
    label: 'Italia',
    hint: 'PEC, fatturazione elettronica, verifiche',
    icon: '🇮🇹',
    examples: [
      {
        title: 'PEC archiviata a norma',
        goal: 'Quando arriva una PEC, archiviala a norma e registra mittente, oggetto e data in una tabella.',
      },
      {
        title: 'Fattura allo SDI',
        goal: 'Quando una fattura è pronta, mandala allo SDI e avvisami dell’esito.',
      },
      {
        title: 'Partita IVA da verificare',
        goal: 'Quando arriva un nuovo cliente, verifica che la partita IVA sia valida e segnalamelo se non lo è.',
      },
    ],
  },
  {
    id: 'avvisi',
    label: 'Avvisi e messaggi',
    hint: 'Farsi avvisare dove si guarda davvero',
    icon: '🔔',
    examples: [
      {
        title: 'Urgenze su Telegram',
        goal: 'Se arriva una email che contiene la parola "urgente" o "scadenza", mandami un messaggio su Telegram con mittente e oggetto.',
      },
      {
        title: 'Riassunto della giornata',
        goal: 'Ogni sera alle 18 manda su Slack un riassunto di cosa è successo oggi.',
      },
      {
        title: 'Sito che non risponde',
        goal: 'Ogni dieci minuti controlla che il sito risponda, e se non risponde avvisami subito.',
      },
    ],
  },
  {
    id: 'assistente',
    label: 'Con l’assistente',
    hint: 'Quando serve leggere e capire, non solo spostare',
    icon: '✨',
    examples: [
      {
        title: 'Priorità della posta',
        goal: 'Quando arriva una email, valuta quanto è urgente e mettila nella cartella corrispondente.',
      },
      {
        title: 'Dati da un ordine',
        goal: 'Quando arriva un ordine per email, estrai articoli e quantità e inseriscili nella tabella ordini.',
      },
      {
        title: 'Bozza di risposta',
        goal: 'Quando arriva una richiesta di preventivo, prepara una bozza di risposta e lasciala nelle bozze senza inviarla.',
      },
    ],
  },
  {
    id: 'web',
    label: 'Web e servizi',
    hint: 'Prendere e mandare dati fuori da Medea',
    icon: '🌐',
    examples: [
      {
        title: 'Ordini dal gestionale',
        goal: 'Ogni ora chiedi al mio gestionale gli ordini nuovi e inseriscili nella tabella ordini.',
      },
      {
        title: 'Modulo dal sito',
        goal: 'Quando qualcuno compila il modulo di contatto, salva i dati e mandami una email con quello che ha scritto.',
      },
      {
        title: 'Prezzo da tenere d’occhio',
        goal: 'Ogni mattina leggi il prezzo di un prodotto da una pagina web e avvisami se è sceso.',
      },
    ],
  },
];

/** Tutti gli esempi di fila, per chi non passa dalle categorie. */
export const WIZARD_EXAMPLES: readonly WizardExample[] = WIZARD_CATEGORIES.flatMap(
  (c) => c.examples,
);
