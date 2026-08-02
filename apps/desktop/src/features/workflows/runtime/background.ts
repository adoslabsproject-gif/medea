/**
 * Medea che resta al lavoro quando la finestra si chiude.
 *
 * Le automazioni girano dentro Medea: il motore è un suo processo figlio e si
 * spegne con lei. Finché chiudere la finestra chiudeva l'applicazione, un cron
 * delle otto del mattino funzionava soltanto se qualcuno teneva la finestra
 * aperta — cioè non era un'automazione.
 *
 * Due interruttori distinti, perché rispondono a due domande diverse: restare
 * in funzione a finestra chiusa copre la giornata; ripartire da soli dopo un
 * riavvio del computer copre il resto. Il secondo senza il primo non serve.
 *
 * @module features/workflows/runtime/background
 */

import { invoke } from '@tauri-apps/api/core';

export interface BackgroundStatus {
  /** Se chiudere la finestra lascia Medea al lavoro. */
  stayAlive: boolean;
  /** Se Medea riparte da sola all'accesso al computer. */
  autostart: boolean;
}

/**
 * Lo stato dei due interruttori.
 *
 * L'avvio automatico lo dichiara il sistema operativo, non una preferenza
 * nostra: qualcuno può aver tolto Medea dagli elementi di avvio senza passare
 * da qui, e in quel caso la schermata deve dire la verità.
 */
export async function backgroundStatus(): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>('background_status');
}

export async function setStayAlive(enabled: boolean): Promise<void> {
  await invoke('background_set_stay_alive', { enabled });
}

export async function setAutostart(enabled: boolean): Promise<void> {
  await invoke('background_set_autostart', { enabled });
}
