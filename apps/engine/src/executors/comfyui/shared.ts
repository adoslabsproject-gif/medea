/**
 * Helper condivisi degli executor ComfyUI: coercion config, clamp, seed,
 * salvataggio del media nel blob-store del tenant.
 *
 * @module executors/comfyui/shared
 */
import { randomUUID, randomInt } from 'node:crypto';
import type { BinaryData } from '@flowforge/core-schema';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';
import type { ComfyFetchedMedia } from './client.js';

export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v === null || v === undefined) return '';
  // object/function/symbol: niente '[object Object]' — serializza in modo sicuro
  try { return JSON.stringify(v) ?? ''; } catch { return ''; }
}

export function toNum(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = toNum(v, def);
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Seed effettivo: 0/assente → casuale (range int32 positivo), altrimenti il valore dato. */
export function resolveSeed(v: unknown): number {
  const n = Math.floor(toNum(v, 0));
  return n > 0 ? n : randomInt(1, 2_147_483_647);
}

/** Normalizza un campo key-value (config) in Record<string,string>. */
export function toVariables(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toStr(val);
  return out;
}

export function newClientId(): string {
  return randomUUID();
}

/**
 * Salva il media nel blob-store del tenant (ref content-addressed). Fail-soft:
 * senza store (alcuni test) ripiega su base64 inline — l'handle BinaryData
 * resta valido per i nodi a valle in entrambi i casi.
 */
export async function saveMedia(ctx: NodeExecutionContext, media: ComfyFetchedMedia): Promise<BinaryData> {
  if (ctx.writeBinary) {
    return ctx.writeBinary(media.bytes, { mimeType: media.mimeType, fileName: media.filename });
  }
  return {
    __ffBinary: true,
    encoding: 'base64',
    mimeType: media.mimeType,
    size: media.bytes.length,
    data: media.bytes.toString('base64'),
    fileName: media.filename,
  };
}
