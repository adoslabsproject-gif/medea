/**
 * Consegnare al motore le chiavi dei modelli AI.
 *
 * I nodi AI di un workflow li esegue il motore, non il desktop: la chiave
 * salvata in Impostazioni deve arrivare fin lì, altrimenti la chat funziona
 * e il workflow fallisce con «nessun provider configurato».
 *
 * Il desktop è la fonte: quello che c'è nel portachiavi finisce nel motore,
 * quello che l'utente toglie viene tolto. Il motore le tiene cifrate nel suo
 * database, e gira solo su `127.0.0.1`.
 *
 * Due provider del desktop non hanno un corrispondente nel motore e restano
 * fuori: «Claude (abbonamento)», che è un programma su questo computer e non
 * una chiave, e l'endpoint personale. Con uno di quei due scelto, i workflow
 * usano il primo provider che ha una chiave.
 */

import { onAiConfigChanged } from '../../ai/config-changes';
import { activeProvider } from '../../ai/connection';
import { getApiKey } from '../../ai/keys';
import { PROVIDER_IDS, type ProviderId } from '../../ai/types';
import { providerPerMotore } from '../scaffold/motore-mappa';

import { runtimeApi, runtimeStatus } from './client';

/**
 * I provider che il motore sa usare con una chiave.
 *
 * Quali siano lo decide `providerPerMotore`, che è già la regola con cui il
 * wizard parla al motore: un secondo elenco scritto a mano qui finirebbe per
 * dire una cosa diversa.
 */
export const PROVIDER_DEL_MOTORE: readonly ProviderId[] = PROVIDER_IDS.filter(
  (p) => providerPerMotore(p) !== null,
);

type ProviderDelMotore = ProviderId;

export interface ConsegnaProviderAi {
  /** Provider la cui chiave è stata scritta nel motore in questa passata. */
  consegnati: ProviderDelMotore[];
  /** Provider tolti dal motore perché il desktop non ne ha più la chiave. */
  tolti: ProviderDelMotore[];
  /** Il provider che i workflow usano per primo. `null`: il primo con chiave. */
  predefinito: ProviderDelMotore | null;
  /** Cosa non è riuscito, in parole. Non blocca il resto. */
  problems: string[];
}

interface StatoMotore {
  providers: { provider: string; hasKey: boolean }[];
}

interface PreferenzeMotore {
  defaultLlmProvider: string | null;
}

/**
 * Le chiavi già consegnate da quando l'app è aperta.
 *
 * Il motore non restituisce mai una chiave, quindi non si può chiedergli se
 * quella che ha è ancora quella giusta. Senza questo ricordo ogni apertura
 * della sezione riscriverebbe tutte le chiavi, e ogni scrittura lascia una
 * riga nel registro di audit.
 */
const consegnate = new Map<ProviderDelMotore, string>();

/** Dimentica cosa è stato consegnato: la prossima passata riscrive tutto. */
export function dimenticaConsegne(): void {
  consegnate.clear();
}

function isProviderDelMotore(value: ProviderId | null): value is ProviderDelMotore {
  return value !== null && PROVIDER_DEL_MOTORE.includes(value);
}

/**
 * Il motivo di un fallimento, senza la chiave dentro.
 *
 * Il motore può ripetere nel messaggio quello che ha ricevuto, e questi
 * problemi finiscono nella console.
 */
function motivo(errore: unknown, chiave: string): string {
  const testo = errore instanceof Error ? errore.message : String(errore);
  return chiave ? testo.split(chiave).join('•••') : testo;
}

/**
 * Allinea il motore al desktop: chiavi e provider preferito.
 *
 * Un fallimento su un provider non ferma gli altri: meglio un workflow che
 * gira con una chiave su due che nessuno.
 */
export async function consegnaProviderAi(): Promise<ConsegnaProviderAi> {
  const esito: ConsegnaProviderAi = { consegnati: [], tolti: [], predefinito: null, problems: [] };

  const stato = await runtimeApi.get<StatoMotore>('/llm-providers');
  const sulMotore = new Set(stato.providers.filter((p) => p.hasKey).map((p) => p.provider));
  const conChiave = new Set<ProviderDelMotore>();

  for (const provider of PROVIDER_DEL_MOTORE) {
    const chiave = await getApiKey(provider);
    try {
      if (chiave) {
        if (!sulMotore.has(provider) || consegnate.get(provider) !== chiave) {
          // Il nome viaggia così com'è: per questi provider coincide, ed è
          // il test di contratto a garantire che il motore lo riconosca.
          await runtimeApi.put(`/llm-providers/${provider}`, { apiKey: chiave });
          consegnate.set(provider, chiave);
          esito.consegnati.push(provider);
        }
        conChiave.add(provider);
      } else {
        consegnate.delete(provider);
        if (sulMotore.has(provider)) {
          await runtimeApi.delete(`/llm-providers/${provider}`);
          esito.tolti.push(provider);
        }
      }
    } catch (e) {
      esito.problems.push(`${provider}: ${motivo(e, chiave)}`);
    }
  }

  // Si dichiara predefinito solo un provider che il motore può usare davvero:
  // una preferenza per uno senza chiave verrebbe ignorata in silenzio.
  const scelto = activeProvider();
  const predefinito = isProviderDelMotore(scelto) && conChiave.has(scelto) ? scelto : null;
  try {
    const preferenze = await runtimeApi.get<PreferenzeMotore>('/llm-providers/preferences');
    if (preferenze.defaultLlmProvider !== predefinito) {
      await runtimeApi.put('/llm-providers/preferences', { defaultLlmProvider: predefinito });
    }
    esito.predefinito = predefinito;
  } catch (e) {
    esito.problems.push(`provider predefinito: ${motivo(e, '')}`);
  }

  return esito;
}

/**
 * Consegna subito, ma solo se il motore è già in piedi.
 *
 * Serve a chi salva una chiave in Impostazioni: avviare il motore per questo
 * sarebbe sproporzionato, e alla prossima apertura dei workflow la consegna
 * avviene comunque.
 */
export async function consegnaProviderAiSeInPiedi(): Promise<ConsegnaProviderAi | null> {
  const stato = await runtimeStatus();
  if (!stato.running) return null;
  return consegnaProviderAi();
}

/**
 * Riconsegna a ogni cambio di provider o di chiave, finché si ascolta.
 *
 * Le consegne vanno in fila: due salvataggi ravvicinati che partissero
 * insieme potrebbero arrivare al motore nell'ordine sbagliato, e resterebbe
 * la chiave vecchia. Restituisce la funzione per smettere.
 */
export function ascoltaConfigurazioneAi(): () => void {
  let coda: Promise<void> = Promise.resolve();
  return onAiConfigChanged(() => {
    coda = coda
      .then(() => consegnaProviderAiSeInPiedi())
      .then((esito) => {
        if (esito && esito.problems.length > 0) {
          console.warn('[runtime] problemi nel consegnare i modelli AI', esito.problems);
        }
      })
      .catch((e: unknown) => {
        console.warn('[runtime] modelli AI non consegnati', e);
      });
  });
}
