/**
 * Le impostazioni che valgono per tutti i workflow.
 *
 * Per ora una sola, ed è quella che cambia di più la vita: **il workflow di
 * emergenza**. Quando un'automazione fallisce, il motore ne lancia un altro
 * passandogli cosa è andato storto.
 *
 * Senza, un cron notturno che smette di funzionare lo si scopre giorni dopo,
 * quando qualcuno nota che una cosa non è stata fatta. Con, si riceve una
 * email — o quello che si preferisce, visto che il workflow di emergenza è un
 * workflow come un altro.
 */

import { runtimeApi } from './client';

export interface ErrorWorkflow {
  /** Quale workflow lanciare quando qualcosa fallisce. Vuoto: nessuno. */
  errorWorkflowId: string | null;
}

export async function errorWorkflow(): Promise<string | null> {
  const risposta = await runtimeApi.get<ErrorWorkflow>('/settings/error-workflow');
  return risposta.errorWorkflowId;
}

/** Sceglie il workflow di emergenza. `null` lo toglie. */
export async function setErrorWorkflow(id: string | null): Promise<void> {
  await runtimeApi.put('/settings/error-workflow', { errorWorkflowId: id });
}
