/**
 * Estrazione PURA del media prodotto dagli `outputs` della history ComfyUI.
 *
 * Un nodo di output ComfyUI espone i file in chiavi note: `images` (SaveImage),
 * `gifs`/`videos` (nodi video/animazione). Qui si normalizza tutto in
 * ComfyMedia[] con `kind` dedotto, opzionalmente filtrando per un nodo preciso.
 *
 * Niente I/O → testabile in isolamento.
 *
 * @module executors/comfyui/extract-output
 */
import { ComfyError, kindForFilename, type ComfyMedia } from './client.js';

interface OutputFile { filename?: unknown; subfolder?: unknown; type?: unknown }

function collectFrom(node: unknown, kindHint: 'image' | 'video' | null): ComfyMedia[] {
  if (node === null || typeof node !== 'object') return [];
  const out: ComfyMedia[] = [];
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    // L'ESTENSIONE vince per i video: SaveVideo emette .mp4 sotto la chiave
    // "images" → senza questo finirebbe in un <img> rotto. Poi le chiavi note,
    // poi l'hint. (.webp animato resta "image" → anima nel <img>, ok.)
    const keyKind: 'image' | 'video' | null = key === 'gifs' || key === 'videos' ? 'video' : key === 'images' ? 'image' : kindHint;
    for (const f of val as OutputFile[]) {
      if (f === null || typeof f !== 'object' || typeof f.filename !== 'string') continue;
      const extKind = kindForFilename(f.filename);
      out.push({
        filename: f.filename,
        subfolder: typeof f.subfolder === 'string' ? f.subfolder : '',
        type: typeof f.type === 'string' ? f.type : 'output',
        kind: extKind === 'video' ? 'video' : (keyKind ?? extKind),
      });
    }
  }
  return out;
}

/**
 * Tutti i media negli outputs. Se `outputNodeId` è valorizzato, guarda solo
 * quel nodo (rigetta se assente). Ordine: rispetta l'ordine dei nodi.
 */
export function extractMedia(outputs: Record<string, unknown>, outputNodeId?: string): ComfyMedia[] {
  const id = (outputNodeId ?? '').trim();
  if (id) {
    if (!(id in outputs)) {
      throw new ComfyError('Nodo di output non trovato', `id "${id}" assente negli output (${Object.keys(outputs).join(', ') || 'nessuno'}).`);
    }
    return collectFrom(outputs[id], null);
  }
  const all: ComfyMedia[] = [];
  for (const node of Object.values(outputs)) all.push(...collectFrom(node, null));
  return all;
}

/** Il PRIMO media, o errore parlante se il grafo non ha prodotto nulla di scaricabile. */
export function firstMedia(outputs: Record<string, unknown>, outputNodeId?: string): ComfyMedia {
  const media = extractMedia(outputs, outputNodeId);
  if (media.length === 0) {
    throw new ComfyError('Nessun media prodotto', 'Il grafo è stato eseguito ma non ha generato immagini/video scaricabili (manca un nodo SaveImage/Save Video?).');
  }
  return media[0]!;
}
