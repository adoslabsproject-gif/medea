/**
 * `@flowforge/nodes-stdlib-sandbox` — runtime helpers iniettati nell'isolate.
 *
 * Pattern Pipedream `

 — il custom node scrive:
 *   const rows = ff.csv.parse(input.body);
 *   const hash = ff.crypto.sha256Hex(payload);
 *
 * Tutto pure JS, no `node:*`, no dipendenze esterne. Bundle target:
 * single-file ESM ~30KB minified iniettabile via `ctx.eval()`.
 *
 * @module sandbox/index
 */
import * as csv from './csv.js';
import * as crypto from './crypto.js';
import * as transform from './transform.js';
import * as text from './text.js';
import * as url from './url.js';
import * as jsonpath from './jsonpath.js';
import * as time from './time.js';

export const ff = {
  csv,
  crypto,
  transform,
  text,
  url,
  jsonpath,
  time,
} as const;

export { csv, crypto, transform, text, url, jsonpath, time };
export type Ff = typeof ff;
