/**
 * versions ROUTE — orchestrazione HTTP del versioning workflow.
 * Il service (snapshot/list/get/rollback/diff) è testato a parte in
 * services/workflow-versions.service.test.ts; qui copriamo status code,
 * tenant guard, validazione param e il path d'errore del rollback (500).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const verMock = vi.hoisted(() => ({
  snapshot: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  rollback: vi.fn(),
  diff: vi.fn(),
}));
const wfMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/services/workflow-versions.service.js', () => ({
  WorkflowVersionsService: vi.fn(() => verMock),
}));
vi.mock('@/services/workflow.service.js', () => ({ WorkflowService: vi.fn(() => wfMock) }));
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'tenant-1' }));
vi.mock('@/lib/actor.js', () => ({ getActorId: () => 'actor-1' }));
vi.mock('@/lib/logger.js');

import { createVersionRoutes } from './versions.js';

function app(): Hono {
  const a = new Hono();
  a.route('/', createVersionRoutes({} as never));
  return a;
}

beforeEach(() => {
  Object.values(verMock).forEach((m) => m.mockReset());
  wfMock.get.mockReset();
});

describe('POST /workflows/:id/versions (snapshot)', () => {
  it('404 se il workflow non è del tenant', async () => {
    wfMock.get.mockResolvedValue(null);
    const res = await app().request('/workflows/wf-x/versions', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(verMock.snapshot).not.toHaveBeenCalled();
  });

  it('201 con lo snapshot quando il workflow esiste; passa actor e comment', async () => {
    wfMock.get.mockResolvedValue({ id: 'wf-1' });
    verMock.snapshot.mockReturnValue({ versionId: 'v1' });
    const res = await app().request('/workflows/wf-1/versions?comment=ciao', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(verMock.snapshot).toHaveBeenCalledWith({ id: 'wf-1' }, 'tenant-1', 'actor-1', 'ciao');
  });
});

describe('GET /workflows/:id/versions (list)', () => {
  it('200 con versions + total derivato dalla lunghezza', async () => {
    verMock.list.mockReturnValue([{ versionId: 'v1' }, { versionId: 'v2' }]);
    const res = await app().request('/workflows/wf-1/versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; versions: unknown[] };
    expect(body.total).toBe(2);
    expect(body.versions).toHaveLength(2);
  });
});

describe('GET /workflows/:id/versions/:versionId', () => {
  it('404 se la versione non esiste', async () => {
    verMock.get.mockReturnValue(null);
    const res = await app().request('/workflows/wf-1/versions/v-x');
    expect(res.status).toBe(404);
  });

  it('200 con il workflow della versione', async () => {
    verMock.get.mockReturnValue({ id: 'wf-1', nodes: [] });
    const res = await app().request('/workflows/wf-1/versions/v1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflow: { id: string } };
    expect(body.workflow.id).toBe('wf-1');
  });
});

describe('POST rollback', () => {
  it('404 quando il service ritorna null (versione/workflow assente)', async () => {
    verMock.rollback.mockResolvedValue(null);
    const res = await app().request('/workflows/wf-1/versions/v1/rollback', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('200 con il workflow ripristinato', async () => {
    verMock.rollback.mockResolvedValue({ id: 'wf-1', restored: true });
    const res = await app().request('/workflows/wf-1/versions/v1/rollback', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('500 con messaggio quando il rollback lancia (errore loggato, non propagato grezzo)', async () => {
    verMock.rollback.mockRejectedValue(new Error('corrupt snapshot'));
    const res = await app().request('/workflows/wf-1/versions/v1/rollback', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('corrupt snapshot');
  });
});

describe('GET diff', () => {
  it('404 se una delle due versioni non esiste (diff null)', async () => {
    verMock.diff.mockReturnValue(null);
    const res = await app().request('/workflows/wf-1/versions/v1/diff/v2');
    expect(res.status).toBe(404);
  });

  it('200 con il diff', async () => {
    verMock.diff.mockReturnValue({ added: [], removed: [] });
    const res = await app().request('/workflows/wf-1/versions/v1/diff/v2');
    expect(res.status).toBe(200);
    expect(verMock.diff).toHaveBeenCalledWith('v1', 'v2', 'tenant-1');
  });
});
