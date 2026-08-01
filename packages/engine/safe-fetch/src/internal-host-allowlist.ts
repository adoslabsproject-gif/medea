/**
 * internal-host-allowlist — allowlist ESPLICITA di host interni per-tenant.
 *
 * Policy di sicurezza (NON config dell'autore del workflow): l'operatore dichiara, via
 * env `FLOWFORGE_INTERNAL_HOST_ALLOWLIST` del container tenant, gli host interni
 * legittimi (es. un ERP on-prem con cert self-signed). SOLO verso questi host:
 *   - il SSRF guard può essere scavalcato (raggiungere l'IP privato), e
 *   - `allowSelfSigned` del nodo HTTP può disattivare la verifica TLS.
 * Verso QUALSIASI altro host (pubblico o IP privato non dichiarato): SSRF guard attivo
 * e verifica TLS SEMPRE on (invariante #201 preservata).
 *
 * Match ESATTO host (case-insensitive), MAI substring/suffix → "internal.local" NON
 * matcha "evil-internal.local" né "internal.local.attacker.com" (anti-bypass). Wildcard
 * solo se dichiarata ESPLICITAMENTE come voce `*.suffix` (sub-dominio, un solo livello a
 * sinistra non basta: deve essere un suffisso dot-bounded).
 *
 * Modulo PURO (zero IO) → testabile. Il parse dell'env e l'estrazione dell'host
 * dall'URL stanno al chiamante (executor).
 */

/** Parsifica la CSV della allowlist in un Set normalizzato (lowercase, trim, no vuoti). */
export function parseInternalHostAllowlist(raw: string | undefined | null): Set<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return new Set();
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const h = part.trim().toLowerCase();
    if (h.length > 0) out.add(h);
  }
  return out;
}

/**
 * Host:porta da esentare dal guard SSRF quando l'URL LLM punta al GATEWAY INTERNO
 * di sistema (es. FLOWFORGE_LIARA_BASE_URL, IP privato della bridge Docker
 * by-design). Decide per CONFRONTO DI ORIGIN → copre sia il default sia un
 * baseUrl passato esplicitamente dal runtime. Un origin DIVERSO (endpoint BYOK
 * dell'utente) → `undefined` (guard pieno).
 *
 * SSOT condivisa (Fase 2 #14): nata in @flowforge/nodes-ai-agents (fix SSRF
 * nLA_liara), spostata qui perché serve anche ai nodi stdlib che parlano col
 * gateway (vision-extract, scrape-smart/extract-llm) — stdlib non può dipendere
 * da ai-agents (dipendenza circolare). ai-agents la re-esporta.
 */
export function internalGatewayTrustedHost(url: string, internalGateway: string | undefined): string | undefined {
  if (!internalGateway) return undefined;
  try {
    const u = new URL(url);
    return u.origin === new URL(internalGateway).origin ? u.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True se `host` è nella allowlist. Match esatto; supporta voci wildcard `*.suffix`
 * (matcha QUALSIASI sotto-dominio di `suffix`, ma NON `suffix` stesso e NON un dominio
 * che finisce per `suffix` senza il punto di confine).
 */
export function isHostAllowlisted(host: string, allowlist: ReadonlySet<string>): boolean {
  if (allowlist.size === 0) return false;
  const h = host.trim().toLowerCase().replace(/\.$/, ''); // tollera trailing dot FQDN
  if (h.length === 0) return false;
  if (allowlist.has(h)) return true;
  // Wildcard esplicita: voce "*.example.internal" → matcha "a.example.internal",
  // "a.b.example.internal", MAI "example.internal" né "notexample.internal".
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".example.internal"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    }
  }
  return false;
}
