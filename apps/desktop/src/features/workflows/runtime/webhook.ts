/**
 * L'indirizzo a cui bussare per far partire un workflow.
 *
 * Il motore lo compone da sé — token derivato da un segreto stabile, porta
 * fissa — e qui si chiede soltanto. È volutamente un indirizzo **locale**:
 * `127.0.0.1` non è raggiungibile da internet, e serve a chi sta su questa
 * macchina — un altro programma, uno script, un tunnel aperto apposta.
 *
 * Dirlo è più onesto che mostrare un indirizzo pubblico che non esiste.
 */

import { runtimeApi } from './client';

export interface WebhookAddress {
  /** L'indirizzo completo, pronto da incollare. */
  url: string;
  /** Come si autentica la chiamata: `none` significa che basta il token. */
  authMode: string;
}

interface Response {
  webhook?: { url?: string | null; path?: string; authMode?: string };
}

/**
 * L'indirizzo del webhook di questo workflow, se ne ha uno.
 *
 * Restituisce niente quando il workflow non ha un nodo webhook: non è un
 * errore, è la condizione della grande maggioranza dei workflow.
 */
export async function webhookAddress(runtimeWorkflowId: string): Promise<WebhookAddress | null> {
  try {
    const response = await runtimeApi.get<Response>(`/workflows/${runtimeWorkflowId}/webhook-url`);
    const url = response.webhook?.url;
    if (!url) return null;
    return { url, authMode: response.webhook?.authMode ?? 'none' };
  } catch {
    // 409 quando non c'è un nodo webhook, 503 quando il segreto manca: in
    // entrambi i casi non c'è un indirizzo da mostrare, e insistere con un
    // errore rosso su un pannello di configurazione sarebbe rumore.
    return null;
  }
}
