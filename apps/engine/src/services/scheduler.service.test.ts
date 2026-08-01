/**
 * Test 2026-grade — SchedulerService (in-process cron + sweeper guard).
 *
 * SECURITY: Sweeper portal usa getActiveCronScheduleCount() per evitare
 *    SIGSTOP container con cron attivi → job salterebbero.
 * PARSER: 5-field cron supportato, wildcard + slash-N + list + exact.
 * RELIABILITY: tick error NON propaga (workflow fail isolato).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger.js';

const listAllAcrossTenantsMock = vi.fn();
class WorkflowServiceMock {
  listAllAcrossTenants = listAllAcrossTenantsMock;
}
vi.mock('./workflow.service.js', () => ({ WorkflowService: WorkflowServiceMock }));

const runExecuteMock = vi.fn();
class RunServiceMock {
  execute = runExecuteMock;
}
vi.mock('./run.service.js', () => ({ RunService: RunServiceMock }));

vi.mock('@/lib/logger.js');
const loggerMock = vi.mocked(logger);

const { SchedulerService } = await import('./scheduler.service.js');

const eventBus = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  runExecuteMock.mockResolvedValue({ runId: 'r-1' });
  listAllAcrossTenantsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('🚨 matchesCron (5-field parser)', () => {
  const m = SchedulerService.matchesCron;

  it('🚨 wildcard "* * * * *" → match always', () => {
    expect(m('* * * * *', new Date('2026-06-07T12:34:00Z'))).toBe(true);
  });

  it('🚨 exact "30 14 * * *" → match 14:30', () => {
    // WE-5 fix: default timezone è UTC. Passo timezone locale per match local time.
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = new Date();
    date.setHours(14, 30, 0, 0);
    expect(m('30 14 * * *', date, localTz)).toBe(true);
    date.setHours(14, 31, 0, 0);
    expect(m('30 14 * * *', date, localTz)).toBe(false);
  });

  it('🚨 stride "*/15 * * * *" → ogni 15 min', () => {
    const d0 = new Date(); d0.setMinutes(0); expect(m('*/15 * * * *', d0)).toBe(true);
    const d15 = new Date(); d15.setMinutes(15); expect(m('*/15 * * * *', d15)).toBe(true);
    const d30 = new Date(); d30.setMinutes(30); expect(m('*/15 * * * *', d30)).toBe(true);
    const d10 = new Date(); d10.setMinutes(10); expect(m('*/15 * * * *', d10)).toBe(false);
  });

  it('🚨 comma list "0,15,30,45 * * * *" → solo i minuti specificati', () => {
    const d0 = new Date(); d0.setMinutes(0); expect(m('0,15,30,45 * * * *', d0)).toBe(true);
    const d15 = new Date(); d15.setMinutes(15); expect(m('0,15,30,45 * * * *', d15)).toBe(true);
    const d20 = new Date(); d20.setMinutes(20); expect(m('0,15,30,45 * * * *', d20)).toBe(false);
  });

  it('🚨 expression con < 5 fields → false (no crash)', () => {
    expect(m('* * *', new Date())).toBe(false);
    expect(m('', new Date())).toBe(false);
  });

  it('🚨 expression con > 5 fields → false', () => {
    expect(m('* * * * * *', new Date())).toBe(false);
  });

  it('🚨 number fuori range → false (no match)', () => {
    const d = new Date();
    d.setHours(14, 30, 0, 0);
    expect(m('99 14 * * *', d)).toBe(false); // min=99
    expect(m('30 25 * * *', d)).toBe(false); // hr=25
  });

  it('🚨 stride */0 → false (no division by zero crash)', () => {
    expect(m('*/0 * * * *', new Date())).toBe(false);
  });

  it('🚨 stride */NaN → false', () => {
    expect(m('*/foo * * * *', new Date())).toBe(false);
  });

  it('🚨 trim whitespace surrounding expression', () => {
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const d = new Date(); d.setMinutes(0); d.setHours(0); d.setDate(1); d.setMonth(0);
    expect(m('  0 0 1 1 *  ', d, localTz)).toBe(true);
  });

  /**
   * 🚨 AUDIT FIX WE-5 (2026-06-09 HIGH) — REGRESSION GUARD:
   *
   * Pre-fix: matchesCron usava date.getMinutes/Hours/Date/Month/Day local-time
   * → workflow con `timezone: 'America/New_York'` fire 6-9 ore di sfasamento
   * dal previsto su container con TZ=Europe/Rome.
   *
   * Post-fix: matchesCron(expression, date, timezone) usa Intl.DateTimeFormat
   * con timezone target → cron fire HH:MM nel timezone del job.
   */
  it('🚨 [REGRESSION WE-5] stesso UTC Date, timezone diverse → match diverso', () => {
    // Data UTC = 2026-06-07 12:00:00 UTC
    // → Europe/Rome (UTC+2 in giugno DST) = 14:00
    // → America/New_York (UTC-4 in giugno DST) = 08:00
    // → UTC = 12:00
    const utcDate = new Date('2026-06-07T12:00:00Z');
    expect(m('0 14 * * *', utcDate, 'Europe/Rome'), 'cron alle 14 deve match Rome 12:00 UTC').toBe(true);
    expect(m('0 14 * * *', utcDate, 'UTC'), 'cron alle 14 NON match UTC 12:00').toBe(false);
    expect(m('0 8 * * *', utcDate, 'America/New_York'), 'cron alle 8 deve match NY 12:00 UTC').toBe(true);
    expect(m('0 12 * * *', utcDate, 'UTC'), 'cron alle 12 match UTC 12:00').toBe(true);
  });

  it('🚨 [REGRESSION WE-5] timezone default UTC se non passato (back-compat)', () => {
    const utcDate = new Date('2026-06-07T12:00:00Z');
    // No timezone arg → default UTC
    expect(m('0 12 * * *', utcDate)).toBe(true);
    expect(m('0 14 * * *', utcDate)).toBe(false);
  });

  it('🚨 [REGRESSION WE-5] DST handling: Europe/Rome marzo (UTC+1 → UTC+2)', () => {
    // 2026-03-28 12:00 UTC (giorno PRIMA dello spring-forward EU)
    // → Europe/Rome = 13:00 (UTC+1 ora solare)
    const beforeDst = new Date('2026-03-28T12:00:00Z');
    expect(m('0 13 * * *', beforeDst, 'Europe/Rome')).toBe(true);
    expect(m('0 14 * * *', beforeDst, 'Europe/Rome')).toBe(false);

    // 2026-03-30 12:00 UTC (giorno DOPO spring-forward — DST attivo)
    // → Europe/Rome = 14:00 (UTC+2 ora legale)
    const afterDst = new Date('2026-03-30T12:00:00Z');
    expect(m('0 14 * * *', afterDst, 'Europe/Rome')).toBe(true);
    expect(m('0 13 * * *', afterDst, 'Europe/Rome')).toBe(false);
  });

  it('🚨 [REGRESSION WE-5] day-of-week timezone-aware (cron Lunedi US vs Italia)', () => {
    // Sun 2026-06-07 23:00 UTC = Mon 2026-06-08 01:00 Rome (UTC+2)
    // = Sun 2026-06-07 19:00 New_York (UTC-4)
    const date = new Date('2026-06-07T23:00:00Z');
    // Cron "* * * * 1" = lunedi nel timezone target
    expect(m('0 1 * * 1', date, 'Europe/Rome'), 'Mon 01:00 Rome (UTC+2)').toBe(true);
    expect(m('0 19 * * 0', date, 'America/New_York'), 'Sun 19:00 NY (UTC-4)').toBe(true);
    // Stesso giorno UTC = Sun
    expect(m('0 23 * * 0', date, 'UTC')).toBe(true);
  });

  it('🚨 [REGRESSION WE-5] timezone invalida → exception controllata (no crash silente)', () => {
    const date = new Date('2026-06-07T12:00:00Z');
    expect(() => m('0 12 * * *', date, 'Mars/Olympus_Mons')).toThrow();
  });
});

describe('🚨 reloadJobs', () => {
  it('🚨 carica solo workflows enabled con trigger_cron', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '*/5 * * * *', timezone: 'UTC' } }] },
      { id: 'wf-2', enabled: true, nodes: [{ defId: 'trigger_webhook', config: {} }] }, // no cron
      { id: 'wf-3', enabled: false, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *' } }] }, // disabled
      { id: 'wf-4', enabled: true, nodes: [{ defId: 'trigger_cron', config: {} }] }, // no expression
    ]);
    const sched = new SchedulerService(eventBus);
    await sched.reloadJobs();
    expect(sched.getActiveCronScheduleCount()).toBe(1);
  });

  it('🚨 cross-tenant scan (listAllAcrossTenants, NON listByTenant)', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([]);
    const sched = new SchedulerService(eventBus);
    await sched.reloadJobs();
    expect(listAllAcrossTenantsMock).toHaveBeenCalled();
  });

  it('🚨 timezone default UTC se mancante', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *' } }] },
    ]);
    const sched = new SchedulerService(eventBus);
    await sched.reloadJobs();
    expect(sched.getActiveCronScheduleCount()).toBe(1);
  });

  it('🚨 stesso job 2x reload → no duplicate (preserva instance per timezone)', async () => {
    const wf = { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *', timezone: 'Europe/Rome' } }] };
    listAllAcrossTenantsMock.mockResolvedValue([wf]);
    const sched = new SchedulerService(eventBus);
    await sched.reloadJobs();
    await sched.reloadJobs();
    expect(sched.getActiveCronScheduleCount()).toBe(1);
  });
});

describe('🚨 start + stop + tick', () => {
  it('🚨 start avvia masterTimer + log', async () => {
    const sched = new SchedulerService(eventBus);
    await sched.start();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ activeJobs: 0 }),
      'Scheduler started',
    );
    sched.stop();
  });

  it('🚨 stop → clear jobs + timer', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *' } }] },
    ]);
    const sched = new SchedulerService(eventBus);
    await sched.start();
    expect(sched.getActiveCronScheduleCount()).toBe(1);
    sched.stop();
    expect(sched.getActiveCronScheduleCount()).toBe(0);
  });

  it('🚨 tick: match cron → execute(triggerType cron)', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *' } }] },
    ]);
    const sched = new SchedulerService(eventBus);
    await sched.start();
    vi.advanceTimersByTime(60_001);
    expect(runExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-1',
      triggerType: 'cron',
    }));
    sched.stop();
  });

  it('🚨 tick: cron non match → no execute', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '0 3 1 1 *' } }] }, // Capodanno 03:00
    ]);
    vi.setSystemTime(new Date('2026-06-07T12:00:00Z'));
    const sched = new SchedulerService(eventBus);
    await sched.start();
    vi.advanceTimersByTime(60_001);
    expect(runExecuteMock).not.toHaveBeenCalled();
    sched.stop();
  });

  it('🚨 tick: execute throw → log error + NON crash (workflow isolato)', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *' } }] },
    ]);
    runExecuteMock.mockRejectedValueOnce(new Error('workflow boom'));
    const sched = new SchedulerService(eventBus);
    await sched.start();
    vi.advanceTimersByTime(60_001);
    // wait microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-1' }),
      'Cron run failed',
    );
    sched.stop();
  });
});

describe('🚨 registerInstance singleton (per sweeper portal)', () => {
  it('🚨 getActiveCronScheduleCount static senza instance → 0', () => {
    SchedulerService.registerInstance(null as any);
    expect(SchedulerService.getActiveCronScheduleCount()).toBe(0);
  });

  it('🚨 registerInstance setta singleton → static getCount delega', async () => {
    listAllAcrossTenantsMock.mockResolvedValueOnce([
      { id: 'wf-1', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '* * * * *' } }] },
      { id: 'wf-2', enabled: true, nodes: [{ defId: 'trigger_cron', config: { cronExpression: '*/5 * * * *' } }] },
    ]);
    const sched = new SchedulerService(eventBus);
    await sched.reloadJobs();
    SchedulerService.registerInstance(sched);
    expect(SchedulerService.getActiveCronScheduleCount()).toBe(2);
  });
});
