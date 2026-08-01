/**
 * Use case — ManageQuarantineUseCase.
 *
 * Restore + Purge dei record quarantinati. Entrambe le operazioni sono
 * sensibili (FK violation, data loss) → audit log esteso con dump
 * completo della riga PRIMA dell'operazione.
 */

import type { DataSourceRef, QuarantineRecord, QuarantineListFilter, QuarantineStats } from '@/services/janitor/domain/index.js';
import type { IQuarantineGateway, IAuditEmitter } from '@/services/janitor/ports/index.js';

export interface RestoreInput {
  readonly quarantineId: number;
  readonly dataSourceRef: DataSourceRef;
  readonly tenantId: string;
  readonly actorId: string;
}

export interface PurgeInput extends RestoreInput {
  /** Conferma testuale da UI ("delete-permanent") — protezione anti-misclick. */
  readonly confirmationToken: string;
}

export class ManageQuarantineUseCase {
  constructor(
    private readonly quarantine: IQuarantineGateway,
    private readonly audit: IAuditEmitter,
  ) {}

  async list(filter: QuarantineListFilter): Promise<readonly QuarantineRecord[]> {
    return this.quarantine.list(filter);
  }

  async stats(dataSourceRef?: DataSourceRef): Promise<QuarantineStats> {
    return this.quarantine.stats(dataSourceRef);
  }

  async restore(input: RestoreInput): Promise<void> {
    // Lookup il record per audit PRIMA della restore (il record sparisce)
    const records = await this.quarantine.list({
      dataSourceRef: input.dataSourceRef,
      cursor: input.quarantineId + 1,
      limit: 1,
    });
    const record = records.find((r) => r.id === input.quarantineId);
    if (!record) throw new Error(`Quarantine record #${input.quarantineId.toString()} non trovato`);

    await this.audit.emit({
      tenantId: input.tenantId,
      action: 'janitor.quarantine.restore',
      resourceType: 'quarantined_row',
      resourceId: String(input.quarantineId),
      actorId: input.actorId,
      metadata: {
        originalTable: record.originalTable,
        originalId: record.originalId,
        ruleId: record.ruleId,
        rawJson: record.rawJson,
      },
    });
    await this.quarantine.restore(input.quarantineId, input.dataSourceRef);
  }

  async purge(input: PurgeInput): Promise<void> {
    // Confirmation token requirement: protezione anti-misclick.
    // UI deve inviare 'DELETE-PERMANENT' come token esatto.
    if (input.confirmationToken !== 'DELETE-PERMANENT') {
      throw new Error('Confirmation token mancante o non valido: serve "DELETE-PERMANENT"');
    }

    // Lookup il record per audit PRIMA del purge
    const records = await this.quarantine.list({
      dataSourceRef: input.dataSourceRef,
      cursor: input.quarantineId + 1,
      limit: 1,
    });
    const record = records.find((r) => r.id === input.quarantineId);
    if (!record) throw new Error(`Quarantine record #${input.quarantineId.toString()} non trovato`);

    await this.audit.emit({
      tenantId: input.tenantId,
      action: 'janitor.quarantine.purge',
      resourceType: 'quarantined_row',
      resourceId: String(input.quarantineId),
      actorId: input.actorId,
      metadata: {
        originalTable: record.originalTable,
        originalId: record.originalId,
        ruleId: record.ruleId,
        rawJson: record.rawJson,
        warning: 'HARD DELETE — questo è l\'ultimo record permanente della riga.',
      },
    });
    await this.quarantine.purge(input.quarantineId, input.dataSourceRef);
  }
}
