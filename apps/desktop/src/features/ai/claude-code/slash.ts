/**
 * I comandi con la barra, come in Claude Code.
 *
 * Quali esistono lo dice la CLI quando parte — i suoi, quelli dell'utente,
 * quelli dei suoi plugin — e Medea li propone mentre si scrive. Il comando
 * poi viaggia come un messaggio qualunque: a eseguirlo è la CLI.
 */

/** Quanti suggerimenti mostrare al massimo. */
const MASSIMO = 8;

/**
 * La parola che l'utente sta scrivendo dopo la barra, o `null` se non sta
 * scrivendo un comando.
 *
 * Un comando è tale solo in testa al messaggio e finché non c'è uno spazio:
 * `/model opus` ha già un comando, e «vedi /tmp/file» non ne ha nessuno.
 */
export function comandoInCorso(input: string): string | null {
  const corrispondenza = /^\/([\w:-]*)$/u.exec(input);
  return corrispondenza ? (corrispondenza[1] ?? '') : null;
}

/** I comandi da proporre per quello che è stato scritto finora. */
export function suggerimenti(input: string, comandi: readonly string[]): string[] {
  const parola = comandoInCorso(input);
  if (parola === null) return [];
  const cercata = parola.toLowerCase();
  const unici = [...new Set(comandi)];
  // Prima quelli che cominciano così, poi quelli che lo contengono.
  const iniziano = unici.filter((c) => c.toLowerCase().startsWith(cercata));
  const contengono = unici.filter(
    (c) => !c.toLowerCase().startsWith(cercata) && c.toLowerCase().includes(cercata),
  );
  return [...iniziano.sort(), ...contengono.sort()].slice(0, MASSIMO);
}

/** Il testo del campo dopo aver scelto un suggerimento. */
export function completa(comando: string): string {
  return `/${comando} `;
}
