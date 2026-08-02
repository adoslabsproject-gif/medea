import ivm from 'isolated-vm';
import { logger } from '@/lib/logger.js';

/**
 * isolated-vm-based sandbox for executing user-supplied expressions and
 * code-node scripts in a TRUE V8 isolate.
 *
 * Compared to the Function()-based interpreter in interpreter.ts:
 *   - No access to globalThis, process, require, fs, Buffer, setTimeout, etc.
 *     Only what we explicitly inject via context.global.set().
 *   - Hard memory limit per isolate (default 32 MB).
 *   - Hard wall-clock timeout per call (default 250 ms).
 *   - Each evaluation is fully isolated — no shared heap with the host process,
 *     no prototype pollution path back to FlowForge code.
 */

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
}

export interface SandboxScope {
  input?: unknown;
  output?: unknown;
  ctx?: unknown;
  item?: unknown;
  index?: number;
  vars?: Record<string, unknown>;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
    public readonly kind: 'syntax' | 'runtime' | 'timeout' | 'memory',
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

const DEFAULT_MEMORY_MB = 32;
const DEFAULT_TIMEOUT_MS = 250;

const FORBIDDEN_PATTERNS = [/\b__proto__\b/, /\bconstructor\.constructor\b/];

function assertSafeExpression(expression: string): void {
  if (expression.length > 4000) {
    throw new SandboxError('Expression exceeds 4000 character limit', expression, 'syntax');
  }
  for (const p of FORBIDDEN_PATTERNS) {
    if (p.test(expression)) {
      throw new SandboxError(
        `Expression contains forbidden token matching ${p.toString()}`,
        expression,
        'syntax',
      );
    }
  }
}

function copyIn(jail: ivm.Reference<Record<string, unknown>>, name: string, value: unknown): void {
  try {
    if (value === undefined) {
      jail.setSync(name, new ivm.ExternalCopy(null).copyInto());
    } else {
      jail.setSync(name, new ivm.ExternalCopy(value).copyInto());
    }
  } catch (error) {
    logger.warn({ err: error, name }, 'Sandbox copyIn failed — value not serializable');
    jail.setSync(name, new ivm.ExternalCopy(null).copyInto());
  }
}

export function evaluateInSandbox(
  expression: string,
  scope: SandboxScope,
  options: SandboxOptions = {},
): unknown {
  assertSafeExpression(expression);

  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_MB;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });

  try {
    const context = isolate.createContextSync();
    const jail = context.global;

    copyIn(jail, 'input', scope.input);
    copyIn(jail, 'output', scope.output);
    copyIn(jail, 'ctx', scope.ctx);
    copyIn(jail, 'item', scope.item);
    if (scope.index !== undefined) jail.setSync('index', scope.index);
    copyIn(jail, 'vars', scope.vars ?? {});

    const wrapped = `(function(){ "use strict"; return (${expression}); })()`;
    let script: ivm.Script;
    try {
      script = isolate.compileScriptSync(wrapped);
    } catch (error) {
      throw new SandboxError(
        `Syntax error: ${error instanceof Error ? error.message : String(error)}`,
        expression,
        'syntax',
      );
    }

    try {
      const result: unknown = script.runSync(context, { timeout: timeoutMs, copy: true });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/timeout|timed out|hit memory limit/i.test(msg)) {
        const kind: SandboxError['kind'] = /memory/i.test(msg) ? 'memory' : 'timeout';
        throw new SandboxError(`${kind} exceeded: ${msg}`, expression, kind);
      }
      throw new SandboxError(`Runtime error: ${msg}`, expression, 'runtime');
    }
  } finally {
    isolate.dispose();
  }
}
