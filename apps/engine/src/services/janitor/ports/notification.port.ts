/**
 * Port — INotificationEmitter.
 *
 * Notifica detection critica → event bus interno + (opzionale) bridge
 * verso failure-notifier esistente per Slack/email. La rule decide
 * `notifyOnDetection`; il framework chiama qui.
 */

import type { JanitorRuleReport } from '@/services/janitor/domain/index.js';

export interface INotificationEmitter {
  notifyDetection(report: JanitorRuleReport): Promise<void>;
}
