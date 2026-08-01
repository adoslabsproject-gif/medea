/**
 * Chiave di rate-limit per le route pubbliche `/webhooks/*` e `/forms/*`:
 * per (webhook, IP).
 *
 * Il primo segmento di path è l'identità del webhook (workflowId, provider
 * integration, formId); l'IP è la sorgente. Così:
 *  - un singolo IP NON può floodare nessun webhook (chiusura del vettore DoS
 *    su `authMode:none`, che ad ogni hit fa girare il workflow = CPU/IO);
 *  - provider legittimi (Stripe/GitHub, IP distinti) restano indipendenti;
 *  - NON è un cap globale per-IP (penalizzerebbe più webhook dietro lo stesso
 *    IP, es. NAT) né per-webhook puro (un provider bursty lo saturerebbe).
 *
 * Modulo dedicato (no import del server) → testabile in isolamento.
 */
export function publicWebhookRateLimitKey(path: string, ip: string): string {
  const seg = /^\/(?:webhooks|forms)\/([^/]+)/u.exec(path)?.[1] ?? 'unknown';
  return `${seg}:${ip}`;
}
