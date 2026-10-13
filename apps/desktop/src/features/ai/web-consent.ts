/**
 * Quando aprire una pagina web chiede il permesso all'utente.
 *
 * La ricerca parte da sola. Aprire una pagina no: manda fuori un indirizzo
 * scelto dal modello, e il modello legge anche testi scritti da estranei.
 * La prima pagina di ogni sito, in ogni conversazione, la conferma l'utente.
 */

import type { ToolCall } from './tools';

/** Se vale `'true'`, le pagine si aprono senza chiedere. Lo sceglie l'utente. */
export const FETCH_SENZA_CONFERMA_KEY = 'medea.ai.web.fetchSenzaConferma';

export function confermaWebDisattivata(): boolean {
  return localStorage.getItem(FETCH_SENZA_CONFERMA_KEY) === 'true';
}

function indirizzo(call: ToolCall): string {
  const url = call.args.url;
  return typeof url === 'string' ? url.trim() : '';
}

/** Il nome del sito che la chiamata vuole aprire, se l'indirizzo si capisce. */
export function sitoDi(call: ToolCall): string | null {
  try {
    const host = new URL(indirizzo(call)).hostname.toLowerCase();
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

export interface RichiestaSito {
  /** Il sito da approvare. `null` se l'indirizzo non si capisce. */
  sito: string | null;
  /** L'indirizzo intero, da mostrare all'utente. */
  url: string;
}

/** I siti che l'utente ha già approvato, conversazione per conversazione. */
export class SitiApprovati {
  private readonly perConversazione = new Map<string, Set<string>>();

  /**
   * Cosa chiedere all'utente prima di aprire la pagina, o `null` se quel
   * sito in questa conversazione è già stato approvato.
   */
  richiesta(conversazione: string | null, call: ToolCall): RichiestaSito | null {
    const sito = sitoDi(call);
    if (sito && conversazione && this.perConversazione.get(conversazione)?.has(sito)) {
      return null;
    }
    return { sito, url: indirizzo(call) };
  }

  approva(conversazione: string | null, sito: string | null): void {
    if (!conversazione || !sito) return;
    const siti = this.perConversazione.get(conversazione) ?? new Set<string>();
    siti.add(sito);
    this.perConversazione.set(conversazione, siti);
  }
}
