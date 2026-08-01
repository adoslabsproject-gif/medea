/**
 * withErrorMapping + withAbortGuard — error handling primitives.
 *
 * withErrorMapping → converte qualunque throw legacy in NodeError tipizzato
 * (placed OUTERMOST cosi\` logger downstream riceve sempre NodeError, mai Error generico).
 *
 * withAbortGuard → short-circuit `AbortedError` se `ctx.abortSignal.aborted`
 * PRIMA di entrare nell'executor. Utile per nodi che non controllano la signal.
 */

import type { NodeExecutor } from '../../types.js';
import { asNodeError, AbortedError } from '../node-error.js';
import type { Middleware } from './compose.js';

export function withErrorMapping(): Middleware {
  return (next: NodeExecutor) => async (config, input, ctx) => {
    try { return await next(config, input, ctx); }
    catch (err) { throw asNodeError(err); }
  };
}

export function withAbortGuard(): Middleware {
  return (next: NodeExecutor) => async (config, input, ctx) => {
    if (ctx.abortSignal?.aborted) {
      throw new AbortedError(`Node ${ctx.nodeId} aborted before exec`);
    }
    return next(config, input, ctx);
  };
}
