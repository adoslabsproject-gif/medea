/**
 * In-process cron scheduler. Iterates over enabled workflows that contain
 * a `trigger_cron` node and registers each on a recurring timer. The
 * scheduler stays in the same Node process — no Redis / BullMQ required
 * for single-host deployments. Multi-host / horizontal scale will swap in
 * a BullMQ adapter behind the same IScheduler port.
 */

import { logger } from '@/lib/logger.js';
import { WorkflowService } from './workflow.service.js';
import { RunService } from './run.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import type { Workflow } from '@medea/engine-core-schema';

interface ScheduledJob {
  workflowId: string;
  cronExpression: string;
  timezone: string;
}

/**
 * Trivial cron parser supporting 5-field expressions: minute hour day month weekday.
 * Each field can be a wildcard, a number, a comma-list, or a stride form using
 * the slash-N syntax. Sufficient for ~95% of practical cron use cases; replace
 * with the cron-parser library when we need ranges like 9-17 or DOM/DOW combos.
 */
function parseCronField(field: string, min: number, max: number): (n: number) => boolean {
  if (field === '*') return () => true;
  if (field.startsWith('*/')) {
    const step = Number(field.slice(2));
    if (!Number.isFinite(step) || step < 1) return () => false;
    return (n) => (n - min) % step === 0;
  }
  if (field.includes(',')) {
    const values = field
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n));
    return (n) => values.includes(n);
  }
  const exact = Number(field);
  if (Number.isFinite(exact) && exact >= min && exact <= max) {
    return (n) => n === exact;
  }
  return () => false;
}

/**
 * AUDIT FIX WE-5 (2026-06-09 HIGH): timezone-aware matchesCron.
 *
 * Pre-fix: matchesCron usava date.getMinutes/Hours/Date/Month/Day → LOCAL
 * time del processo Node.js. Container Docker gira con TZ=Europe/Rome
 * (env onboarding) → workflow con cron `timezone: 'Europe/Rome'` casualmente
 * funzionava per coincidenza. Workflow con `timezone: 'America/New_York'`
 * (utente USA) o `'UTC'` fallivano di 6-9 ore.
 *
 * Post-fix: estrai i field temporali dal `date` UTC convertendoli al timezone
 * target via Intl.DateTimeFormat (built-in, robusto). Pattern enterprise
 * Vercel/Render: pass timezone explicit → cron fire HH:MM nel timezone del job.
 *
 * NB: gestisce DST automaticamente — durante spring-forward 02:00→03:00
 * il cron "30 2 * * *" NON fire (il "02:30" non esiste). Durante fall-back
 * 03:00→02:00 il cron "30 2 * * *" fire 2 volte (corretto come standard cron).
 */
function getDatePartsInTimezone(
  date: Date,
  timezone: string,
): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayShort = get('weekday');
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    day: Number(get('day')),
    month: Number(get('month')),
    dayOfWeek: dowMap[weekdayShort] ?? 0,
  };
}

function matchesCron(expression: string, date: Date, timezone = 'UTC'): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hrF, dayF, monF, dowF] = fields as [string, string, string, string, string];
  const parts = getDatePartsInTimezone(date, timezone);
  return (
    parseCronField(minF, 0, 59)(parts.minute) &&
    parseCronField(hrF, 0, 23)(parts.hour) &&
    parseCronField(dayF, 1, 31)(parts.day) &&
    parseCronField(monF, 1, 12)(parts.month) &&
    parseCronField(dowF, 0, 7)(parts.dayOfWeek)
  );
}

export class SchedulerService {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly workflows: WorkflowService;
  private readonly runs: RunService;
  private masterTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Numero di cron schedules attivi (workflow enabled + trigger_cron). Usato
   * dal portal lifecycle sweeper via `/api/v1/internal/cron-schedules-count`
   * per evitare di pausare un container con cron attivi: SIGSTOP fermerebbe
   * il setInterval del scheduler → i job programmati salterebbero firing.
   * Pattern Vercel/Render in attesa dello scheduler centrale full.
   */
  getActiveCronScheduleCount(): number {
    return this.jobs.size;
  }

  /**
   * Reference statico singleton-style per consumo HTTP. Settato da server.ts
   * dopo la creazione dell'istanza scheduler (deps wiring).
   */
  private static currentInstance: SchedulerService | null = null;
  static registerInstance(s: SchedulerService): void {
    SchedulerService.currentInstance = s;
  }
  static getActiveCronScheduleCount(): number {
    return SchedulerService.currentInstance?.getActiveCronScheduleCount() ?? 0;
  }

  constructor(eventBus: IEventBus) {
    this.workflows = new WorkflowService(eventBus);
    this.runs = new RunService(eventBus);
  }

  async start(): Promise<void> {
    await this.reloadJobs();
    this.masterTimer = setInterval(() => {
      this.tick();
    }, 60_000);
    logger.info({ activeJobs: this.jobs.size }, 'Scheduler started');
  }

  stop(): void {
    if (this.masterTimer) clearInterval(this.masterTimer);
    this.masterTimer = null;
    this.jobs.clear();
  }

  private extractCronJob(workflow: Workflow): { expression: string; timezone: string } | null {
    const cronNode = workflow.nodes.find((n) => n.defId === 'trigger_cron');
    if (!cronNode) return null;
    const expression = cronNode.config.cronExpression;
    const timezone = cronNode.config.timezone ?? 'UTC';
    if (!expression) return null;
    return { expression, timezone };
  }

  async reloadJobs(): Promise<void> {
    // Cross-tenant scan — cron jobs from any tenant must be scheduled.
    // tenantId for the run is read from workflow.tenantId, preserving
    // isolation downstream. See same fix in TriggerWatchersService.reload().
    const all = await this.workflows.listAllAcrossTenants();
    const next = new Map<string, ScheduledJob>();

    for (const workflow of all) {
      if (!workflow.enabled) continue;
      const cron = this.extractCronJob(workflow);
      if (!cron) continue;
      const existing = this.jobs.get(workflow.id);
      if (existing?.cronExpression === cron.expression && existing.timezone === cron.timezone) {
        next.set(workflow.id, existing);
        this.jobs.delete(workflow.id);
        continue;
      }
      next.set(workflow.id, {
        workflowId: workflow.id,
        cronExpression: cron.expression,
        timezone: cron.timezone,
      });
    }

    this.jobs.clear();
    for (const [id, job] of next) this.jobs.set(id, job);
  }

  private tick(): void {
    const now = new Date();
    for (const job of this.jobs.values()) {
      // AUDIT FIX WE-5 (2026-06-09): pass timezone job-specific → cron fire
      // HH:MM nel timezone del workflow, no più 1-9h drift.
      if (matchesCron(job.cronExpression, now, job.timezone)) {
        void this.runs
          .execute({
            workflowId: job.workflowId,
            triggerType: 'cron',
            triggerInput: {
              firedAt: now.toISOString(),
              cronExpression: job.cronExpression,
              timezone: job.timezone,
            },
          })
          .catch((err: unknown) => {
            logger.error({ err, workflowId: job.workflowId }, 'Cron run failed');
          });
      }
    }
  }

  // Test-only helper
  static matchesCron = matchesCron;
}
