import { describe, it, expect, beforeEach } from 'vitest';
import { createJob, completeJob, failJob, getJob, __resetScaffoldJobs } from './scaffold-jobs.js';

beforeEach(() => __resetScaffoldJobs());

describe('scaffold-jobs — il risultato sopravvive al drop della connessione SSE', () => {
  it('createJob → running; completeJob → done + result; getJob lo legge', () => {
    createJob('j1');
    expect(getJob('j1')?.status).toBe('running');
    completeJob('j1', { workflow: { id: 'wf' } });
    const j = getJob('j1');
    expect(j?.status).toBe('done');
    expect(j?.result).toEqual({ workflow: { id: 'wf' } });
  });

  it('failJob → error + httpStatus', () => {
    createJob('j2');
    failJob('j2', 'boom', 502);
    const j = getJob('j2');
    expect(j?.status).toBe('error');
    expect(j?.error).toBe('boom');
    expect(j?.httpStatus).toBe(502);
  });

  it('jobId sconosciuto → undefined', () => {
    expect(getJob('nope')).toBeUndefined();
  });

  it('completeJob può sovrascrivere un running (il server finisce dopo il drop)', () => {
    createJob('j3');
    // simulazione: stream cade (running) → poi il server completa
    completeJob('j3', { ok: true });
    expect(getJob('j3')?.status).toBe('done');
  });

  it('hard cap MAX_JOBS → non cresce illimitato (anti-leak)', () => {
    for (let i = 0; i < 250; i++) { createJob(`bulk-${i.toString()}`); }
    // dopo il cap, i più vecchi sono droppati; il più recente resta.
    expect(getJob('bulk-249')).toBeDefined();
    let present = 0;
    for (let i = 0; i < 250; i++) { if (getJob(`bulk-${i.toString()}`)) present++; }
    expect(present).toBeLessThanOrEqual(200);
  });
});
