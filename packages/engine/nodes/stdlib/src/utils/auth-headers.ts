/**
 * Build HTTP auth headers da un picker (none/basic/bearer/apikey-header/custom).
 *
 * Estratto da http.ts in modulo shared per riuso da altri nodi HTTP outbound
 * (fetch-advanced, webhook-call, integrations/*). Pura function, no side effects.
 *
 * Security: nessun log dei valori secret (basicPass, bearerToken, apiKeyValue).
 * Il chiamante (executor) e\` responsabile per la rotazione/storage.
 */

import { safeString } from './safe-coerce.js';

export type AuthMode = 'none' | 'basic' | 'bearer' | 'apikey-header' | 'custom';

export interface AuthConfig {
  authMode?: string;
  basicUser?: unknown;
  basicPass?: unknown;
  bearerToken?: unknown;
  apiKeyHeaderName?: unknown;
  apiKeyValue?: unknown;
  customAuthHeaderName?: unknown;
  customAuthHeaderValue?: unknown;
}

export function buildAuthHeaders(config: AuthConfig): Record<string, string> {
  const mode = (typeof config.authMode === 'string' ? config.authMode : 'none') as AuthMode;
  switch (mode) {
    case 'none':
      return {};
    case 'basic': {
      const user = safeString(config.basicUser);
      const pass = safeString(config.basicPass);
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }
    case 'bearer': {
      const token = safeString(config.bearerToken);
      return token ? { Authorization: `Bearer ${token}` } : {};
    }
    case 'apikey-header': {
      const name = safeString(config.apiKeyHeaderName) || 'X-API-Key';
      const value = safeString(config.apiKeyValue);
      return value ? { [name]: value } : {};
    }
    case 'custom': {
      const name = safeString(config.customAuthHeaderName) || 'Authorization';
      const value = safeString(config.customAuthHeaderValue);
      return value ? { [name]: value } : {};
    }
    // 'oauth2' (client_credentials) NON è gestito qui: richiede un token-fetch ASYNC
    // con cache → l'http executor ottiene l'access-token e inietta il Bearer a parte.
    // Questa funzione PURA copre solo gli schemi a header statico.
    default:
      return {};
  }
}
