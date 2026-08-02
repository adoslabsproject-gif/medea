/**
 * Client per un backend compatibile con l'API di ComfyUI.
 *
 * Usato dalla route privata `/studio` (gen-studio owner-only). L'endpoint è un
 * servizio INTERNO/fidato (self-hosted sulla rete privata del server) → si usa
 * `fetch` diretto, NON la safe-fetch SSRF-guarded dei nodi sandbox (che
 * bloccherebbe gli IP privati 172.20.0.1/127.0.0.1 dove gira ComfyUI).
 *
 * CONFINE DI SICUREZZA (anti-SSRF): l'URL NON proviene MAI da config/input del
 * workflow. È sempre `process.env.STUDIO_COMFY_URL` (default http://172.20.0.1:8188),
 * impostato dall'OPERATORE — un autore non può puntarlo a un host arbitrario.
 * Inoltre nessuna credenziale viaggia nelle request (no Authorization header).
 * Se in futuro un executor costruisse il client da config autore, l'URL andrebbe
 * prima validato (vedi `assertConnectHostAllowed`).
 *
 * Flusso ComfyUI:
 *   1. POST /prompt { prompt: <graph>, client_id }  → { prompt_id, node_errors }
 *   2. GET  /history/{prompt_id}  (polling)          → { <id>: { outputs, status } }
 *   3. GET  /view?filename&subfolder&type            → byte del media
 *
 * @module executors/comfyui/client
 */

import { readJsonCapped, readTextTruncated, readBytesCapped } from '@/lib/capped-response.js';

/** Cap download media generato (immagine/video) — 64MB generoso, anti-OOM. */
const COMFY_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

/** Un riferimento a un file prodotto da un nodo ComfyUI (immagine/video). */
export interface ComfyFileRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyMedia extends ComfyFileRef {
  /** 'image' | 'video' — dedotto dalla chiave di output e dall'estensione. */
  kind: 'image' | 'video';
}

export interface ComfyFetchedMedia extends ComfyMedia {
  bytes: Buffer;
  mimeType: string;
}

/** Errore parlante: porta il motivo grezzo del backend per la diagnostica. */
export class ComfyError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = 'ComfyError';
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

export function mimeForFilename(filename: string): string {
  return MIME_BY_EXT[extOf(filename)] ?? 'application/octet-stream';
}

export function kindForFilename(filename: string): 'image' | 'video' {
  return ['mp4', 'webm', 'gif'].includes(extOf(filename)) ? 'video' : 'image';
}

export class ComfyClient {
  private readonly base: string;

  constructor(comfyUrl: string) {
    const trimmed = (comfyUrl ?? '').trim().replace(/\/+$/, '');
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
      throw new ComfyError(
        'Endpoint di generazione non valido',
        `"${comfyUrl}" — atteso un URL http(s). Imposta STUDIO_COMFY_URL (env operatore).`,
      );
    }
    this.base = trimmed;
  }

  /** Accoda un grafo. Rigetta se ComfyUI segnala errori di validazione sui nodi. */
  async submitPrompt(graph: unknown, clientId: string, signal?: AbortSignal): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
        signal: signal ?? null,
      });
    } catch (err) {
      throw new ComfyError(
        'Backend di generazione non raggiungibile (gen-mode attivo?)',
        err instanceof Error ? err.message : String(err),
      );
    }
    const text = (await readTextTruncated(res, 2 * 1024 * 1024)).text;
    if (!res.ok) {
      throw new ComfyError(
        'Il backend ha rifiutato il grafo',
        `HTTP ${res.status} ${text.slice(0, 600)}`,
      );
    }
    let body: { prompt_id?: string; node_errors?: Record<string, unknown> };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ComfyError('Risposta /prompt non in JSON', text.slice(0, 300));
    }
    if (body.node_errors && Object.keys(body.node_errors).length > 0) {
      throw new ComfyError(
        'Grafo non valido (node_errors)',
        JSON.stringify(body.node_errors).slice(0, 600),
      );
    }
    if (!body.prompt_id) throw new ComfyError('Il backend non ha restituito un prompt_id');
    return body.prompt_id;
  }

  /** Polling bounded della history finché il prompt produce output o scade il timeout. */
  async waitForOutputs(
    promptId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ComfyError('Generazione annullata');
      await sleep(1000, signal);
      let entry:
        | {
            outputs?: Record<string, unknown>;
            status?: { completed?: boolean; status_str?: string; messages?: unknown };
          }
        | undefined;
      try {
        const res = await fetch(`${this.base}/history/${encodeURIComponent(promptId)}`, {
          signal: signal ?? null,
        });
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        const hist = await readJsonCapped<Record<string, typeof entry>>(res);
        entry = hist[promptId];
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        throw new ComfyError(
          'Esecuzione fallita sul backend',
          JSON.stringify(entry.status.messages ?? '').slice(0, 600),
        );
      }
      if (entry.outputs && Object.keys(entry.outputs).length > 0) return entry.outputs;
      if (entry.status?.completed) return entry.outputs ?? {};
    }
    throw new ComfyError(
      'Timeout: generazione non completata nel tempo previsto',
      lastErr || `> ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  /**
   * Controllo NON bloccante dello stato di un prompt (per il pattern async:
   * submit → poll dal client). Una sola fetch, niente attesa.
   */
  async checkHistory(promptId: string): Promise<{
    state: 'pending' | 'done' | 'error';
    outputs?: Record<string, unknown>;
    error?: string;
  }> {
    let entry:
      | {
          outputs?: Record<string, unknown>;
          status?: { completed?: boolean; status_str?: string; messages?: unknown };
        }
      | undefined;
    try {
      const res = await fetch(`${this.base}/history/${encodeURIComponent(promptId)}`);
      if (!res.ok) return { state: 'pending' };
      const hist = await readJsonCapped<Record<string, typeof entry>>(res);
      entry = hist[promptId];
    } catch {
      return { state: 'pending' };
    }
    if (!entry) return { state: 'pending' };
    if (entry.status?.status_str === 'error') {
      return {
        state: 'error',
        error: JSON.stringify(entry.status.messages ?? 'errore').slice(0, 300),
      };
    }
    if (entry.outputs && Object.keys(entry.outputs).length > 0)
      return { state: 'done', outputs: entry.outputs };
    if (entry.status?.completed) return { state: 'done', outputs: entry.outputs ?? {} };
    return { state: 'pending' };
  }

  /** Scarica i byte di un file prodotto (immagine/video). */
  async fetchMedia(ref: ComfyMedia, signal?: AbortSignal): Promise<ComfyFetchedMedia> {
    const url = `${this.base}/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder)}&type=${encodeURIComponent(ref.type)}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: signal ?? null });
    } catch (err) {
      throw new ComfyError(
        'Download del media fallito',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) throw new ComfyError('Download del media fallito', `HTTP ${res.status}`);
    const bytes = await readBytesCapped(res, COMFY_MEDIA_MAX_BYTES);
    const mimeType =
      res.headers.get('content-type')?.split(';')[0]?.trim() || mimeForFilename(ref.filename);
    return { ...ref, bytes, mimeType };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ComfyError('Generazione annullata'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ComfyError('Generazione annullata'));
      },
      { once: true },
    );
  });
}
