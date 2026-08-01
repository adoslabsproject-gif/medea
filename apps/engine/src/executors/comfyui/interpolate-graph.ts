/**
 * Sostituzione PURA delle variabili `{{nome}}` in un grafo ComfyUI (API format).
 *
 * Il grafo arriva come stringa JSON (campo `graphJson`); le variabili sono
 * coppie nome→valore (già risolte dall'engine per eventuali {{espressioni}}).
 * La sostituzione è type-aware: se un valore JSON è ESATTAMENTE un singolo token
 * (`"seed": "{{seed}}"`) e la variabile è numerica/booleana, viene iniettata col
 * tipo giusto (`"seed": 42`, non `"42"`); se il token è dentro una stringa più
 * grande (`"a photo of {{soggetto}}"`) si fa interpolazione testuale.
 *
 * Niente I/O → testabile in isolamento.
 *
 * @module executors/comfyui/interpolate-graph
 */
import { ComfyError } from './client.js';
import type { ComfyGraph } from './txt2img-graph.js';

const WHOLE_TOKEN = /^\{\{\s*([\w.-]+)\s*\}\}$/;
const INLINE_TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Inferisce il tipo di un valore-variabile per l'iniezione "whole token". */
function typedValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // numero JSON valido (interi/decimali/notazione scientifica), niente spazi
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw.trim()) && raw.trim() !== '') return Number(raw.trim());
  return raw;
}

function substituteValue(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE_TOKEN.exec(value);
    if (whole) {
      const name = whole[1]!;
      // token sconosciuto → lascio invariato (diagnosi a valle), non crasho
      return name in vars ? typedValue(vars[name]!) : value;
    }
    return value.replace(INLINE_TOKEN, (m, name: string) => (name in vars ? vars[name]! : m));
  }
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, vars));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteValue(v, vars);
    return out;
  }
  return value;
}

/**
 * Parsa il grafo, sostituisce le variabili e ne valida la forma minima
 * (oggetto di nodi con `class_type`). Rigetta con errore parlante se il JSON è
 * invalido o la forma non è un grafo ComfyUI.
 */
export function substituteGraphVariables(graphJson: string, variables: Record<string, string>): ComfyGraph {
  const raw = (graphJson ?? '').trim();
  if (!raw) throw new ComfyError('Grafo vuoto', 'Il campo "Grafo (API format)" è obbligatorio.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ComfyError('Grafo JSON non valido', err instanceof Error ? err.message : String(err));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ComfyError('Grafo non valido', 'Atteso un oggetto { "<id>": { "class_type": ... } } (formato API di ComfyUI).');
  }
  const substituted = substituteValue(parsed, variables) as Record<string, unknown>;
  const nodes = Object.values(substituted);
  if (nodes.length === 0 || !nodes.every((n) => n !== null && typeof n === 'object' && typeof (n as { class_type?: unknown }).class_type === 'string')) {
    throw new ComfyError('Grafo non valido', 'Ogni nodo deve avere un "class_type" stringa (formato API di ComfyUI).');
  }
  return substituted as ComfyGraph;
}
