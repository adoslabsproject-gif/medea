/**
 * connect-host-guard — SSRF guard per i nodi che aprono una CONNESSIONE (non-HTTP)
 * verso un host fornito dall'autore del workflow: SMTP/IMAP (mail), e in futuro
 * FTP/DB/ecc. `action_http` ha già il suo guard via `@medea/engine-safe-fetch`; questi
 * nodi mail si connettevano a `config.host` SENZA controllo → un editor poteva
 * puntarli a 172.20.0.1:6379 (Redis), gateway, Postgres = port-scan/SSRF interno.
 *
 * Politica (coerente con egress-policy/action_http):
 *  - host nell'allowlist host-interni del tenant (gestita dall'OPERATORE, non
 *    dall'autore) → AMMESSO (on-prem: un mail server interno legittimo).
 *  - altrimenti → deve essere un host PUBBLICO (no IP privati/loopback/link-local/
 *    localhost/reserved). Riusa la validazione letterale di safe-fetch.
 *
 * @module lib/connect-host-guard
 */
import { validateUrlForFetch } from '@medea/engine-safe-fetch';
import { resolveOutboundDispatcher } from './egress-policy.js';

/**
 * Lancia se `host` non è ammesso come target di connessione. `null`/vuoto → lancia
 * (un host vuoto non è un target valido). `label` solo per il messaggio d'errore.
 */
export function assertConnectHostAllowed(host: string, label = 'connessione'): void {
  if (!host) throw new Error(`${label}: host mancante`);
  // 1) host interno esplicitamente fidato dall'operatore (on-prem) → ammesso.
  if (resolveOutboundDispatcher(host, false).allowlisted) return;
  // 2) altrimenti deve essere pubblico. validateUrlForFetch valida i LETTERALI
  //    (IP privati/loopback/link-local/localhost/reserved + scheme); host nudo →
  //    lo incapsuliamo in https:// per riusare la stessa logica.
  if (!validateUrlForFetch(`https://${host}`).ok) {
    throw new Error(
      `${label}: host "${host}" non ammesso — interno/privato/localhost (protezione SSRF). ` +
      `Usa un host PUBBLICO, oppure chiedi all'operatore di aggiungerlo all'allowlist host-interni del tenant.`,
    );
  }
}
