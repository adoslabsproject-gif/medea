/**
 * withTelemetry — wrap executor in OpenTelemetry span.
 *
 * Attributes default flowforge.{tenant_id, run_id, node_id, def_id}.
 * Custom attrs statici via `attrs`, dinamici per-call via `dynamicAttrs`.
 */

import type { NodeExecutor, NodeExecutionContext } from '../../types.js';
import { withSpan, type SpanAttributes } from '../telemetry.js';
import type { Middleware } from './compose.js';

export interface TelemetryOptions {
  spanName?: string;
  attrs?: SpanAttributes;
  dynamicAttrs?: (config: Record<string, unknown>, ctx: NodeExecutionContext) => SpanAttributes;
}

export function withTelemetry(opts: TelemetryOptions = {}): Middleware {
  const spanName = opts.spanName ?? 'node.exec';
  return (next: NodeExecutor) => async (config, input, ctx) => {
    const dynamic = opts.dynamicAttrs ? opts.dynamicAttrs(config, ctx) : {};
    const attrs: SpanAttributes = {
      'flowforge.tenant_id': ctx.tenantId,
      'flowforge.run_id': ctx.runId,
      'flowforge.node_id': ctx.nodeId,
      ...(ctx.defId ? { 'flowforge.def_id': ctx.defId } : {}),
      ...opts.attrs,
      ...dynamic,
    };
    return withSpan(spanName, attrs, () => next(config, input, ctx));
  };
}
