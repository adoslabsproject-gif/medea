/**
 * extract-json — estrazione TOLLERANTE del JSON dall'output LLM del singleshot.
 *
 * Il constrained decoding (guided_json/xgrammar) garantisce JSON puro SOLO su
 * Liara/vLLM. Coi provider BYOK (Anthropic, OpenAI, …) che NON onorano guided_json,
 * l'output arriva spesso avvolto in un fence ```json … ``` o con prosa attorno →
 * `JSON.parse` diretto esplode ("Unexpected token '`'"). Questo helper PURO:
 *   1. toglie il fence ```json/``` se presente;
 *   2. prova il parse diretto;
 *   3. in fallback estrae il PRIMO oggetto JSON bilanciato annidato nel testo
 *      (gestendo le graffe dentro le stringhe con l'escaping).
 * Lancia un errore chiaro se non trova un oggetto JSON valido.
 *
 * @module services/ai-scaffold/extract-json
 */

/** Toglie i fence ```json … ``` (o ``` … ```), altrimenti ritorna il testo trimmato. */
export function stripCodeFences(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```(?:json)?\s*\n?/u, '').replace(/\n?```\s*$/u, '').trim();
}

/** Primo oggetto JSON BILANCIATO nel testo (ignora le graffe dentro le stringhe). */
export function firstBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Estrae e parsa il JSON dell'output scaffold, tollerando fence/prosa.
 * Lancia Error con messaggio chiaro se non c'è JSON valido (il chiamante lo
 * incapsula in AiScaffoldError 502).
 */
export function parseScaffoldJson(raw: string): unknown {
  const stripped = stripCodeFences(raw);
  try {
    return JSON.parse(stripped);
  } catch {
    const candidate = firstBalancedJsonObject(stripped);
    if (candidate !== null) {
      return JSON.parse(candidate); // se anche questo fallisce, propaga (parse error reale)
    }
    throw new Error('output senza un oggetto JSON valido');
  }
}
