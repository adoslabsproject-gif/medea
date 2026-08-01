/**
 * Adapter — AuditEmitter sopra il servizio audit esistente del runtime.
 *
 * Non re-implementa nulla — delega all'AuditLogService che già sa
 * gestire append-only + hash chain. Layer fine ma utile per isolare
 * i use case dal modulo audit (test = mock di un'unica interfaccia).
 */

import type { AuditLogService } from '@/services/audit.service.js';
import type { IAuditEmitter, AuditEvent } from '@/services/janitor/ports/index.js';

export class AuditEmitterAdapter implements IAuditEmitter {
  constructor(private readonly audit: AuditLogService) {}

  async emit(event: AuditEvent): Promise<void> {
    const payload: Parameters<AuditLogService['append']>[0] = {
      tenantId: event.tenantId,
      action: event.action,
      resourceType: event.resourceType,
    };
    if (event.resourceId !== undefined) payload.resourceId = event.resourceId;
    if (event.actorId !== undefined) payload.actorId = event.actorId;
    if (event.metadata !== undefined) payload.metadata = event.metadata;
    await this.audit.append(payload);
  }
}
