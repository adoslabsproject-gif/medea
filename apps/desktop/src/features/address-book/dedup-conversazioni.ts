/**
 * Un oggetto ripetuto è quasi sempre una conversazione, non tante email.
 *
 * Dieci messaggi con lo stesso oggetto sono dieci righe che dicono la stessa
 * cosa, e l'ultima quasi sempre le contiene tutte: le risposte citano ciò che
 * c'era prima. Mostrarle tutte allunga l'elenco senza aggiungere niente.
 *
 * Il «quasi sempre» però esiste, ed è il motivo per cui qui non si accorpa a
 * occhi chiusi. Ci sono oggetti che tornano identici su contenuti che non
 * c'entrano niente fra loro — «Fattura», «Ordine», «Buongiorno», le notifiche
 * automatiche — e accorparli farebbe sparire messaggi veri. Quando i contenuti
 * sono troppo diversi per essere la stessa conversazione, le righe restano
 * separate.
 *
 * @module features/address-book/dedup-conversazioni
 */

export interface EmailAccorpabile {
  id: number;
  subject: string | null;
  internalDate: string | null;
  preview: string | null;
}

export interface Conversazione<T extends EmailAccorpabile> {
  /** La più recente: quella che si mostra. */
  ultima: T;
  /** Quante ne sono state accorpate sotto, compresa quella mostrata. */
  quante: number;
}

/**
 * L'oggetto senza i prefissi di risposta e inoltro, in minuscolo.
 *
 * `Re: R: Fwd: Preventivo` e `Preventivo` sono lo stesso discorso. I prefissi
 * si tolgono a ripetizione perché si accumulano: dopo tre scambi si arriva a
 * `R: Re: R: …`, e togliendone uno solo resterebbero due oggetti diversi.
 */
export function oggettoNormalizzato(subject: string | null): string {
  let testo = (subject ?? '').trim();
  // I prefissi che l'italiano e l'inglese usano davvero, più la forma con
  // il numero fra parentesi quadre che alcuni client aggiungono.
  const prefisso = /^\s*(?:re|r|fw|fwd|i|risp)\s*(?:\[\d+\])?\s*:\s*/i;
  while (prefisso.test(testo)) testo = testo.replace(prefisso, '');
  return testo.trim().toLowerCase();
}

/**
 * Le parole significative di un testo, per confrontarne due.
 *
 * Si scartano le più corte di quattro lettere: articoli, preposizioni e
 * saluti sono uguali in qualunque email e direbbero che due messaggi si
 * somigliano anche quando non hanno niente in comune.
 */
function parole(testo: string | null): Set<string> {
  return new Set(
    (testo ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((p) => p.length >= 4),
  );
}

/**
 * Quanto due testi si somigliano, da 0 a 1.
 *
 * È la proporzione di parole in comune sul totale delle parole distinte. Due
 * testi senza parole significative si considerano simili: non c'è niente su
 * cui dire il contrario, e in dubbio si accorpa — l'alternativa è riempire
 * l'elenco di righe uguali.
 */
export function somiglianza(primo: string | null, secondo: string | null): number {
  const a = parole(primo);
  const b = parole(secondo);
  if (a.size === 0 || b.size === 0) return 1;

  let comuni = 0;
  for (const parola of a) if (b.has(parola)) comuni += 1;
  return comuni / (a.size + b.size - comuni);
}

/**
 * Sotto questa soglia due messaggi con lo stesso oggetto sono considerati
 * discorsi diversi e restano separati.
 *
 * Il valore è basso di proposito: l'accorpamento è la norma — le risposte
 * citano il testo precedente e si somigliano molto — e si rinuncia solo
 * davanti a contenuti che non hanno quasi niente in comune.
 */
export const SOGLIA_SOMIGLIANZA = 0.12;

/**
 * Accorpa le email con lo stesso oggetto, tenendo la più recente.
 *
 * L'ordine in ingresso non conta: si ordina per data decrescente e si tiene
 * la prima di ogni gruppo. Le email prive di data finiscono in fondo, dove
 * stanno le cose di cui non si sa quando sono successe.
 */
export function accorpaConversazioni<T extends EmailAccorpabile>(
  emails: readonly T[],
): Conversazione<T>[] {
  const quando = (e: T): number => {
    const t = e.internalDate ? Date.parse(e.internalDate) : Number.NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  const ordinate = [...emails].sort((a, b) => quando(b) - quando(a));

  /** Per ogni oggetto normalizzato, i gruppi già aperti. */
  const perOggetto = new Map<string, Conversazione<T>[]>();
  const risultato: Conversazione<T>[] = [];

  for (const email of ordinate) {
    const chiave = oggettoNormalizzato(email.subject);
    const gruppi = perOggetto.get(chiave);

    if (!gruppi) {
      const nuovo: Conversazione<T> = { ultima: email, quante: 1 };
      perOggetto.set(chiave, [nuovo]);
      risultato.push(nuovo);
      continue;
    }

    // Stesso oggetto: si entra nel gruppo solo se anche il contenuto regge il
    // confronto con quello che il gruppo mostra.
    const compatibile = gruppi.find(
      (g) => somiglianza(g.ultima.preview, email.preview) >= SOGLIA_SOMIGLIANZA,
    );
    if (compatibile) {
      compatibile.quante += 1;
    } else {
      const nuovo: Conversazione<T> = { ultima: email, quante: 1 };
      gruppi.push(nuovo);
      risultato.push(nuovo);
    }
  }

  return risultato;
}
