/**
 * La password come va mandata al server, e come spiegare un rifiuto.
 */

import { PRESETS, type Preset } from './presets';

/** La forma di una «password per le app»: sedici lettere minuscole. */
const PASSWORD_PER_APP = /^[a-z]{16}$/u;

/**
 * La password da usare per collegarsi.
 *
 * Google e Yahoo mostrano la password per le app in quattro gruppi di quattro
 * lettere, e chi la copia dalla pagina si porta dietro gli spazi — a volte
 * spazi non separabili, indistinguibili a occhio. Il server li conta come
 * caratteri e rifiuta una password giusta.
 *
 * Gli spazi si tolgono solo quando quello che resta ha esattamente quella
 * forma. Qualunque altra password passa com'è: se contiene spazi sono suoi.
 */
export function passwordDaUsare(digitata: string): string {
  const senzaSpazi = digitata.replace(/\s/gu, '');
  return PASSWORD_PER_APP.test(senzaSpazi) ? senzaSpazi : digitata;
}

/** Vero se il server ha rifiutato le credenziali, e non il collegamento. */
function credenzialiRifiutate(errore: string): boolean {
  return /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535/iu.test(errore);
}

/**
 * L'errore di accesso, con accanto quello che l'utente può farci.
 *
 * «Invalid credentials» detto a chi ha appena digitato la password giusta del
 * proprio account Google non spiega niente: Google quella password, da un
 * programma di posta, non la accetta mai.
 */
export function spiegaAccessoFallito(preset: Preset, errore: string): string {
  if (!credenzialiRifiutate(errore)) return errore;
  if (!PRESETS[preset].vuolePasswordPerApp) return errore;

  const dove =
    preset === 'gmail'
      ? ' Si crea da Account Google → Sicurezza → Verifica in 2 passaggi → Password per le app, ed è fatta di 16 lettere.'
      : '';
  return (
    `Il server ha rifiutato le credenziali. Questo provider non accetta la password dell'account da un programma di posta: ne serve una «password per le app».${dove} ` +
    `Controlla anche che l'indirizzo sia scritto giusto. (${errore})`
  );
}
