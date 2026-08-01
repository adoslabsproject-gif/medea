/**
 * Custom Node Editor — domain errors.
 *
 * Pattern enterprise (Cappella Sistina): error class per fail mode discriminato.
 * Caller pattern-matches `instanceof` invece di string-match `error.message`.
 *
 * Status code mapping (REST layer): vedi `routes/custom-nodes.ts`.
 *   ValidationError      → 400 Bad Request
 *   NotFoundError        → 404 Not Found
 *   ConflictError        → 409 Conflict (slug duplicato, semver duplicato)
 *   QuotaExceededError   → 402 Payment Required (upgrade plan)
 *   ForbiddenError       → 403 Forbidden (RBAC role insufficiente)
 *   CompileError         → 422 Unprocessable Entity (TS errors, esbuild failure)
 *   SecurityViolationError → 422 Unprocessable Entity (forbidden import/eval/etc.)
 *
 * Tutte le classi estendono `CustomNodeError` per single-catch `instanceof CustomNodeError`.
 *
 * @module services/custom-nodes/errors
 */

/** Base class — discrimina via `code` field (machine-readable). */
export class CustomNodeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly meta: Record<string, unknown>;

  constructor(opts: { code: string; message: string; status: number; meta?: Record<string, unknown> }) {
    super(opts.message);
    this.name = 'CustomNodeError';
    this.code = opts.code;
    this.status = opts.status;
    this.meta = opts.meta ?? {};
  }
}

export class CustomNodeValidationError extends CustomNodeError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super({ code: 'CUSTOM_NODE_VALIDATION', message, status: 400, ...(meta ? { meta } : {}) });
    this.name = 'CustomNodeValidationError';
  }
}

export class CustomNodeNotFoundError extends CustomNodeError {
  constructor(id: string) {
    super({ code: 'CUSTOM_NODE_NOT_FOUND', message: `Custom node ${id} not found`, status: 404, meta: { id } });
    this.name = 'CustomNodeNotFoundError';
  }
}

export class CustomNodeConflictError extends CustomNodeError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super({ code: 'CUSTOM_NODE_CONFLICT', message, status: 409, ...(meta ? { meta } : {}) });
    this.name = 'CustomNodeConflictError';
  }
}

export class CustomNodeQuotaExceededError extends CustomNodeError {
  constructor(opts: { current: number; limit: number; planCode: string; suggestedPlan?: string | undefined }) {
    super({
      code: 'CUSTOM_NODE_QUOTA_EXCEEDED',
      message: `Custom node quota exceeded: ${opts.current.toString()}/${opts.limit.toString()} for plan "${opts.planCode}". ` +
        (opts.suggestedPlan ? `Upgrade to "${opts.suggestedPlan}" for more.` : ''),
      status: 402,
      meta: opts,
    });
    this.name = 'CustomNodeQuotaExceededError';
  }
}

export class CustomNodeForbiddenError extends CustomNodeError {
  constructor(reason: string) {
    super({ code: 'CUSTOM_NODE_FORBIDDEN', message: reason, status: 403 });
    this.name = 'CustomNodeForbiddenError';
  }
}

export class CustomNodeCompileError extends CustomNodeError {
  constructor(message: string, meta: { diagnostics?: unknown[]; sourceFile?: string }) {
    super({ code: 'CUSTOM_NODE_COMPILE_ERROR', message, status: 422, meta });
    this.name = 'CustomNodeCompileError';
  }
}

export class CustomNodeSecurityViolationError extends CustomNodeError {
  constructor(violation: string, meta: { pattern?: string; line?: number; file?: string; diagnostics?: unknown[] }) {
    super({
      code: 'CUSTOM_NODE_SECURITY_VIOLATION',
      message: `Security violation: ${violation}`,
      status: 422,
      meta,
    });
    this.name = 'CustomNodeSecurityViolationError';
  }
}
