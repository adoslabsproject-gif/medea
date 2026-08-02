/**
 * Errori tipati del DB-agent di Liara.
 *
 * Ogni errore porta un `code` stabile (machine-readable) usato dall'executor
 * per costruire un ToolResult `{ ok:false, code, error }` deterministico — mai
 * un 500 opaco. I messaggi sono in italiano e NON rivelano MAI l'esistenza di
 * risorse di altri tenant (anti-enumeration): un DB di un altro tenant e un DB
 * inesistente producono lo STESSO messaggio.
 *
 * @module services/db-agent/errors
 */

export type DbAgentErrorCode =
  | 'TENANT_SCOPE'
  | 'TOOL_VALIDATION'
  | 'CONFIRMATION_REQUIRED'
  | 'UNKNOWN_TOOL'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class DbAgentError extends Error {
  constructor(
    readonly code: DbAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DbAgentError';
  }
}

/**
 * Violazione del confine tenant: il target non appartiene al tenant del
 * contesto, oppure si è tentato di iniettare un tenant via argomenti.
 * Messaggio volutamente identico a "non trovato" per non leakare l'esistenza
 * di DB altrui.
 */
export class TenantScopeError extends DbAgentError {
  constructor(message: string) {
    super('TENANT_SCOPE', message);
    this.name = 'TenantScopeError';
  }
}

export class ToolValidationError extends DbAgentError {
  constructor(message: string) {
    super('TOOL_VALIDATION', message);
    this.name = 'ToolValidationError';
  }
}

/** Operazione distruttiva senza la conferma esplicita richiesta. */
export class ConfirmationRequiredError extends DbAgentError {
  constructor(message: string) {
    super('CONFIRMATION_REQUIRED', message);
    this.name = 'ConfirmationRequiredError';
  }
}

export class UnknownToolError extends DbAgentError {
  constructor(toolName: string) {
    super('UNKNOWN_TOOL', `Tool DB sconosciuto: "${toolName}".`);
    this.name = 'UnknownToolError';
  }
}
