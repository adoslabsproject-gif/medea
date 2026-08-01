/**
 * safeParseJson — utility condivisa per parsing safe di valori che POSSONO
 * essere stringhe JSON o gia` object.
 *
 * CONTRACT (workflow-engine):
 *   step.output e` SEMPRE una stringa JSON nel DB (vedi safeStringify in
 *   workflow-engine.ts riga 264). Ogni consumer che legge step.output via
 *   { output?: unknown } DEVE deserializzare prima di accedere ai campi.
 *
 * Bug pattern storico (regression validata 2026-05-29 su flowforge standalone
 * + replicata su SaaS): consumer che fa `if (typeof output !== 'object')
 * continue` salta sempre perche` output e` string → utente riceve envelope
 * fallback {runId, status} invece dell'HTML/JSON atteso.
 *
 * Comportamento:
 *   undefined     → null  (compat invoke.ts/mcp.ts originali)
 *   ''            → null
 *   non-string    → ritorna come-is (gia` deserializzato)
 *   string JSON   → JSON.parse(value)
 *   string broken → ritorna la stringa come-is (caller decide skip o usa)
 */
export function safeParseJson(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value !== 'string') return value;
  if (value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
