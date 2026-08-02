/**
 * secure-dispatcher — undici Agent con `connect.lookup` hook anti-SSRF.
 *
 * Layer 2 della difesa SSRF DNS-rebinding (Layer 1 = pre-risoluzione statica in
 * `safe-outbound-fetch.ts`). Questo layer è l'opera completa: la validazione
 * avviene al MOMENTO DELLA CONNESSIONE, sullo STESSO indirizzo IP che la socket
 * userà → **zero TOCTOU**. Copre automaticamente anche ogni hop di redirect e
 * ogni connessione del pool (l'Agent è il dispatcher di tutte le richieste).
 *
 * Come funziona:
 *   - undici (sotto al `fetch` globale di Node) chiama `lookup(host, opts, cb)`
 *     appena prima di aprire la socket TCP.
 *   - `secureLookup` risolve TUTTI gli indirizzi (all:true), valida ognuno con
 *     `validateIpForFetch` (stesse regole private/loopback/link-local/metadata
 *     del guard) e fallisce la connessione (callback con error) se UNO solo è
 *     interno. Altrimenti passa la lista validata a undici.
 *   - Un host pubblico con TTL bassissimo che fa rebinding a 127.0.0.1 viene
 *     bloccato perché la validazione è sulla risoluzione EFFETTIVAMENTE usata.
 *
 * Node-only (importa `undici` + `node:dns`): MAI nel bundle browser dell'editor.
 * L'Agent è creato lazy (singleton) alla prima richiesta non-trusted.
 */

import { lookup as dnsLookupCb, type LookupAddress, type LookupOptions } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';
import { validateIpForFetch } from '@medea/engine-safe-fetch';

/** Opzioni passate da undici/Node a `lookup` (forma standard dns.LookupOptions). */
type SecureLookupOptions = LookupOptions;

/** Callback dns.lookup nelle due forme: all → array, single → (address, family). */
type SecureLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Errore di connessione bloccata per SSRF. `code` ENETUNREACH così undici/fetch
 * lo trattano come errore di rete (mappato a NetworkError dal wrapper).
 */
export class SsrfConnectBlockedError extends Error {
  readonly code = 'ENETUNREACH';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfConnectBlockedError';
  }
}

/**
 * lookup hook anti-SSRF. Risolve sempre TUTTI gli indirizzi per validarli, poi
 * risponde nel formato (all vs single) richiesto dal chiamante originale.
 */
export function secureLookup(
  hostname: string,
  options: SecureLookupOptions,
  callback: SecureLookupCallback,
): void {
  const opts = { ...options, all: true as const, verbatim: options.verbatim ?? true };
  dnsLookupCb(hostname, opts, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses;
    for (const a of list) {
      const r = validateIpForFetch(a.address);
      if (!r.ok) {
        callback(
          new SsrfConnectBlockedError(
            `SSRF blocked (connect): "${hostname}" risolve a IP non permesso ${a.address} — ${r.reason ?? 'BLOCKED'} (${r.detail ?? 'private/reserved'})`,
          ),
          '',
          0,
        );
        return;
      }
    }
    // Tutti gli indirizzi validati → rispondi nel formato richiesto.
    if (options.all) {
      callback(null, list);
      return;
    }
    const first = list[0];
    if (!first) {
      callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    callback(null, first.address, first.family);
  });
}

let dispatcher: Agent | undefined;
let permissive: Agent | undefined;
let insecureTls: Agent | undefined;

/**
 * Agent undici singleton con il lookup hook anti-SSRF. Bloccato come dispatcher
 * GLOBALE del `fetch` di Node (vedi `installGlobalSecureDispatcher`) → protegge
 * OGNI `fetch` raw del runtime (action_http e tutti gli executor stdlib) senza
 * doverli toccare uno a uno.
 */
export function getSecureDispatcher(): Agent {
  dispatcher ??= new Agent({ connect: { lookup: secureLookup } });
  return dispatcher;
}

/**
 * Agent "permissivo" (lookup di default, nessun blocco IP privati). Usato da
 * `safeOutboundFetch` SOLO quando `allowPrivateHost: true` (servizi interni
 * trusted) per SCAVALCARE il dispatcher globale sicuro e poter raggiungere
 * l'IP privato del servizio.
 */
export function getPermissiveDispatcher(): Agent {
  permissive ??= new Agent();
  return permissive;
}

/**
 * Agent per host INTERNI ALLOWLISTED con cert self-signed: lookup di default (raggiunge
 * l'IP privato, scavalcando il blocco SSRF globale) + `connect.rejectUnauthorized:false`
 * (accetta cert self-signed). ⛔ USARE SOLO per un host che ha passato
 * `isHostAllowlisted` E con `allowSelfSigned=true` — disattiva la verifica TLS, quindi
 * MAI per host pubblici (sarebbe MITM). La verifica per-hop è responsabilità del
 * chiamante (action_http sceglie il dispatcher host-per-host, redirect inclusi).
 */
export function getInsecureTlsDispatcher(): Agent {
  insecureTls ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureTls;
}

/**
 * Installa il dispatcher sicuro come GLOBALE per il `fetch` di Node. Da chiamare
 * UNA volta allo startup del runtime. Idempotente.
 */
export function installGlobalSecureDispatcher(): void {
  setGlobalDispatcher(getSecureDispatcher());
}

/** Per i test: resetta i singleton (così si possono verificare nuove istanze). */
export function __resetSecureDispatcherForTest(): void {
  dispatcher = undefined;
  permissive = undefined;
  insecureTls = undefined;
}
