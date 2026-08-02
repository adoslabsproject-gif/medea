/**
 * Adapter — NotificationEmitterAdapter.
 *
 * Quando una rule ha `notifyOnDetection: true` E ha catturato almeno 1 riga
 * critica (o messo righe in quarantena), questo adapter consegna una NOTIFICA
 * IN-APP REALE agli owner del workspace:
 *   1. Logga warning (sempre, per l'audit operativo).
 *   2. Risolve i destinatari (owner del tenant) e crea una notifica per ognuno
 *      → consegnata in tempo reale al bell via notifications-bus (SSE per-utente).
 *
 * STORIA (2026-06-15): prima emetteva un evento bus `janitor.detection` che
 * NESSUN consumer leggeva (orfano), mentre la UI prometteva "notifica Dashboard".
 * Promessa rotta → cablato al sistema notifiche reale. NB: Slack/email NON sono
 * canali Janitor (esistono solo come `workflow.onError` via failure-notifier) →
 * la UI è stata corretta per non prometterli.
 */

import { logger } from '@/lib/logger.js';
import type { INotificationEmitter } from '@/services/janitor/ports/index.js';
import type { JanitorRuleReport } from '@/services/janitor/domain/index.js';

/**
 * Sink minimale verso le notifiche in-app. NotificationsService lo soddisfa
 * strutturalmente — qui dipendiamo dal port, non dal servizio concreto, così
 * l'adapter è testabile senza toccare il DB.
 */
export interface INotificationSink {
  /** user_id degli owner del workspace da notificare (tenant-scoped). */
  tenantAdminUserIds(tenantId: string): string[];
  create(input: { userId: string; type: string; actorName: string; preview: string }): void;
}

const NOTIFICATION_TYPE = 'janitor.detection';
const ACTOR = 'FlowForge Janitor';

export class NotificationEmitterAdapter implements INotificationEmitter {
  constructor(private readonly notifications: INotificationSink) {}

  notifyDetection(report: JanitorRuleReport): Promise<void> {
    if (report.bySeverity.critical === 0 && report.rowsQuarantined === 0) {
      // Nulla di nuovo da notificare — solo dry-run o detection senza azione.
      return Promise.resolve();
    }

    logger.warn(
      {
        ruleId: report.ruleId,
        tenantId: report.tenantId,
        rowsQuarantined: report.rowsQuarantined,
        critical: report.bySeverity.critical,
        dataSourceRef: report.dataSourceRef,
      },
      'Janitor: detection critica',
    );

    const recipients = this.notifications.tenantAdminUserIds(report.tenantId);
    if (recipients.length === 0) {
      // Nessun owner a cui consegnare (workspace senza owner enabled): resta il
      // warn sopra. Non è un errore — è uno stato osservabile, non silenzioso.
      logger.warn(
        { tenantId: report.tenantId, ruleId: report.ruleId },
        'Janitor detection: nessun owner del workspace da notificare',
      );
      return Promise.resolve();
    }

    const preview = buildPreview(report);
    for (const userId of recipients) {
      this.notifications.create({ userId, type: NOTIFICATION_TYPE, actorName: ACTOR, preview });
    }

    return Promise.resolve();
  }
}

/** Anteprima leggibile (clampata a 200 char dal create()). Esportata per i test. */
export function buildPreview(report: JanitorRuleReport): string {
  const critical = report.bySeverity.critical;
  const criticalPart = critical > 0 ? `, di cui ${critical.toString()} critiche` : '';
  return `🧹 Janitor "${report.ruleId}": ${report.rowsQuarantined.toString()} riga/e in quarantena${criticalPart} su ${report.targetTable}`;
}
