/**
 * Guard ANTI-ESFILTRAZIONE di credenziali (audit 2026-06-20, finding sistemico).
 *
 * Il guard SSRF (`safeOutboundFetch`) blocca gli IP INTERNI/loopback/IMDS — per design
 * NON blocca l'invio verso host PUBBLICI controllati dall'attaccante. Diversi nodi
 * costruiscono l'URL (o l'host base) da CONFIG del tenant e ci attaccano sopra un
 * credential header (Bearer/Basic, client_secret, refresh_token). Un attaccante che
 * controlla quella config (es. `eventUri = https://attacker.com/x`, `instanceUrl` libero)
 * riceve la credenziale in chiaro.
 *
 * REGOLA: prima di spedire QUALSIASI credenziale su un URL derivato da input non vincolato,
 * l'host va validato contro un'allowlist di SUFFISSI del provider. Mai credential header su
 * host arbitrario.
 *
 * @module lib/host-allowlist
 */

/** Sollevata quando l'host di destinazione non è nell'allowlist del provider. */
export class HostNotAllowedError extends Error {
  readonly host: string;
  readonly allowed: readonly string[];
  constructor(host: string, allowed: readonly string[]) {
    super(
      `host non consentito per l'invio di credenziali: "${host}" ` +
        `(atteso uno di: ${allowed.join(', ')}). Bloccato per prevenire esfiltrazione.`,
    );
    this.name = 'HostNotAllowedError';
    this.host = host;
    this.allowed = allowed;
  }
}

/**
 * `true` se `host` è esattamente `suffix` o un suo sotto-dominio (`*.suffix`).
 *
 * Matching SICURO contro i trucchi classici:
 *  - `attacker.com` con suffix `calendly.com` → false (non finisce con `.calendly.com`)
 *  - `evilcalendly.com` (no dot) → false
 *  - `api.calendly.com.attacker.com` → false (finisce con `.attacker.com`)
 */
function hostMatchesSuffix(host: string, suffix: string): boolean {
  const h = host.toLowerCase();
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/**
 * Lancia {@link HostNotAllowedError} se l'host di `url` NON è in `allowedSuffixes`.
 * Da chiamare PRIMA di attaccare credenziali a una request verso un URL derivato da config.
 *
 * @param url             URL completo di destinazione.
 * @param allowedSuffixes domini/suffissi consentiti (es. `['calendly.com']`,
 *                        `['salesforce.com', 'force.com']`).
 */
export function assertHostAllowed(url: string, allowedSuffixes: readonly string[]): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new HostNotAllowedError('(URL non valido)', allowedSuffixes);
  }
  if (!allowedSuffixes.some((s) => hostMatchesSuffix(host, s))) {
    throw new HostNotAllowedError(host, allowedSuffixes);
  }
}
