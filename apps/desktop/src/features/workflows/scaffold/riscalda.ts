/**
 * Sveglia il modello quando si apre il wizard, non quando serve.
 *
 * Un server di inferenza scarica il modello dalla memoria della scheda quando
 * nessuno lo usa. Chi ne ha uno tutto per sé — cioè chiunque usi Medea dal
 * proprio computer — lo trova quasi sempre spento, e la prima richiesta paga
 * il caricamento: il 2026-08-04 sono stati 220 secondi senza risposta, per una
 * generazione che a modello caldo è durata sedici.
 *
 * È anche la differenza con FlowForge, che gira sul server insieme al modello,
 * con traffico continuo: lì non dorme mai, e nessuno ha mai pagato quell'attesa.
 *
 * Non si risolve aspettando meglio. Si risolve non facendosi trovare col
 * modello spento: fra l'apertura del wizard e il momento in cui si preme
 * «Costruisci» passano le decine di secondi che servono a scrivere cosa si
 * vuole, e sono esattamente quelle che servono a caricarlo.
 *
 * @module features/workflows/scaffold/riscalda
 */

import { aiApi } from '../../ai/api';
import { activeProvider, providerConnection } from '../../ai/connection';

/**
 * Manda una richiesta minima al provider configurato, e dimentica l'esito.
 *
 * Ogni errore viene ingoiato di proposito: se il riscaldamento non riesce, il
 * wizard funziona lo stesso — solo più lentamente la prima volta. Trasformarlo
 * in un messaggio significherebbe disturbare l'utente per un tentativo che non
 * gli avevamo promesso.
 */
export function riscaldaModello(): void {
  void (async () => {
    try {
      const provider = activeProvider();
      // La CLI in abbonamento non ha un modello da svegliare: avviarla
      // costerebbe un processo per niente.
      if (provider === 'claude-cli') return;

      const conn = await providerConnection(provider);
      await aiApi.warmup({
        provider,
        systemPrompt: '',
        history: [{ role: 'user', content: 'ok' }],
        apiKey: conn.apiKey,
        baseUrl: conn.baseUrl,
        model: conn.model,
      });
    } catch {
      // Volutamente muto: era un favore, non un requisito.
    }
  })();
}
