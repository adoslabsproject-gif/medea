/**
 * Port — IAuditEmitter.
 *
 * Wrapper attorno all'AuditLogService esistente del runtime. Astratto qui
 * per testabilità + non leakare la struttura di audit_log nei use case.
 */

export interface AuditEvent {
  readonly tenantId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly actorId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface IAuditEmitter {
  emit(event: AuditEvent): Promise<void>;
}
