/**
 * Contract test ANTI-DRIFT — action_http (auth modes ⊆ enum, e viceversa).
 *
 * Storia (review nodi): la description prometteva OAuth1/OAuth2 NON implementati.
 * RISOLTO IMPLEMENTANDO OAuth2 client_credentials (modulo oauth2.ts: token endpoint
 * → Bearer cachato) → ora 'oauth2' È nell'enum e DEVE essere documentato.
 * Restano FUORI (non implementati): OAuth1 (RFC 5849) e OAuth2 authorization_code
 * a 3 gambe (richiede redirect utente) — i loro vecchi claim aspirazionali non
 * devono tornare. Una modalità citata come supportata DEVE esistere nell'enum, e
 * ogni modalità reale dev'essere documentata. Claim fantasma → rosso.
 */
import { describe, it, expect } from 'vitest';
import { httpNodeDef } from './definition.js';
import { HttpAuthModeSchema } from './schema.js';

const description = httpNodeDef.description;
// HttpAuthModeSchema = z.enum([...]).default('none') (ZodDefault) → l'enum interno ha .options
const authModes = HttpAuthModeSchema.removeDefault().options; // enum = unica fonte di verità

describe('action_http — contract description ⊆ schema (anti-drift)', () => {
  it('🚨 OAuth2 client_credentials È supportato (∈ enum + documentato); OAuth1/3-legged NO', () => {
    expect(authModes).toContain('oauth2');           // implementato
    expect(authModes).not.toContain('oauth1');        // non implementato
    expect(description).toMatch(/OAuth2\s+client_credentials/i);
    // I vecchi claim fantasma NON devono tornare.
    expect(description).not.toMatch(/OAuth1\s*\(RFC/i);
    expect(description).not.toMatch(/OAuth2\s*\(token via vault/i);
  });

  it('🚨 ogni authMode reale (eccetto none) è documentato nella description', () => {
    const humanTerm: Record<string, RegExp> = {
      basic: /Basic/,
      bearer: /Bearer/,
      'apikey-header': /API Key/,
      custom: /Custom/,
      oauth2: /OAuth2/,
    };
    for (const mode of authModes) {
      if (mode === 'none') continue;
      const term = humanTerm[mode];
      expect(term, `authMode '${mode}' senza mapping nel contract test`).toBeDefined();
      expect(description, `authMode '${mode}' non documentato nella description`).toMatch(term!);
    }
  });

  it('🚨 i body type citati nella description ⊆ enum bodyType', () => {
    // La description elenca le forme di body: nessuna deve essere inventata.
    // (verifica leggera: i termini chiave presenti combaciano con l'enum reale)
    const bodyField = httpNodeDef.configFields.find((f) => f.key === 'bodyType');
    const opts = (bodyField?.type === 'select' ? bodyField.options : []) ?? [];
    expect(opts).toContain('multipart');
    expect(opts).toContain('raw-text');
    // "Raw-text"/"Raw-binary"/"Binary" citati → esistono come opzioni reali
    expect(description).toMatch(/Raw-text/i);
    expect(opts).toContain('binary');
  });
});
