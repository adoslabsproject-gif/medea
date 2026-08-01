/**
 * runs-archive ROUTE — orchestrazione HTTP (il service è già testato a parte:
 * services/runs-archive.service.test.ts copre path-traversal + HMAC).
 *
 * Qui verifichiamo: tenant guard (404 se il workflow non è del tenant),
 * propagazione del 400 su filename invalido, 404 su archivio assente, e
 * gli header del download (gzip + attachment + content-length).
 */
import type * as FsNS from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const wfMock = vi.hoisted(() => ({ get: vi.fn() }));
const svcMock = vi.hoisted(() => ({ listArchives: vi.fn(), archivePathSafe: vi.fn() }));
const fsMock = vi.hoisted(() => ({ statSync: vi.fn(), readFileSync: vi.fn() }));

vi.mock('@/services/workflow.service.js', () => ({ WorkflowService: vi.fn(() => wfMock) }));
vi.mock('@/services/runs-archive.service.js', () => ({
  listArchives: svcMock.listArchives,
  archivePathSafe: svcMock.archivePathSafe,
}));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof FsNS>();
  return { ...real, statSync: fsMock.statSync, readFileSync: fsMock.readFileSync };
});
vi.mock('@/lib/tenant.js', () => ({ getTenantId: () => 'tenant-1' }));

import { createRunsArchiveRoutes } from './runs-archive.js';

function app(): Hono {
  const a = new Hono();
  // eventBus non usato dai path testati: stub minimale.
  a.route('/', createRunsArchiveRoutes({} as never));
  return a;
}

beforeEach(() => {
  wfMock.get.mockReset();
  svcMock.listArchives.mockReset();
  svcMock.archivePathSafe.mockReset();
  fsMock.statSync.mockReset();
  fsMock.readFileSync.mockReset();
});

describe('GET /workflows/:id/runs/archive (lista)', () => {
  it('404 se il workflow non appartiene al tenant (tenant guard)', async () => {
    wfMock.get.mockResolvedValue(null);
    const res = await app().request('/workflows/wf-x/runs/archive');
    expect(res.status).toBe(404);
    expect(svcMock.listArchives).not.toHaveBeenCalled();
  });

  it('200 con la lista archivi quando il workflow è del tenant', async () => {
    wfMock.get.mockResolvedValue({ id: 'wf-1' });
    svcMock.listArchives.mockReturnValue([{ filename: 'runs-2026-06-a.jsonl.gz', sizeBytes: 10, hash: '', createdAt: '2026-06-01' }]);
    const res = await app().request('/workflows/wf-1/runs/archive');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archives: unknown[] };
    expect(body.archives).toHaveLength(1);
    expect(svcMock.listArchives).toHaveBeenCalledWith('wf-1');
  });
});

describe('GET /workflows/:id/runs/archive/:filename (download)', () => {
  it('404 se il workflow non è del tenant — PRIMA di toccare il filesystem', async () => {
    wfMock.get.mockResolvedValue(null);
    const res = await app().request('/workflows/wf-x/runs/archive/runs-2026-06-a.jsonl.gz');
    expect(res.status).toBe(404);
    expect(svcMock.archivePathSafe).not.toHaveBeenCalled();
    expect(fsMock.statSync).not.toHaveBeenCalled();
  });

  it('400 se archivePathSafe rigetta il filename (path-traversal)', async () => {
    wfMock.get.mockResolvedValue({ id: 'wf-1' });
    svcMock.archivePathSafe.mockReturnValue(null);
    const res = await app().request('/workflows/wf-1/runs/archive/' + encodeURIComponent('../../etc/passwd'));
    expect(res.status).toBe(400);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('404 se il file non esiste su disco (statSync throw)', async () => {
    wfMock.get.mockResolvedValue({ id: 'wf-1' });
    svcMock.archivePathSafe.mockReturnValue('/data/archives/wf-1/runs-2026-06-a.jsonl.gz');
    fsMock.statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const res = await app().request('/workflows/wf-1/runs/archive/runs-2026-06-a.jsonl.gz');
    expect(res.status).toBe(404);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('200 + header gzip/attachment/content-length sul download valido', async () => {
    wfMock.get.mockResolvedValue({ id: 'wf-1' });
    svcMock.archivePathSafe.mockReturnValue('/data/archives/wf-1/runs-2026-06-a.jsonl.gz');
    fsMock.statSync.mockReturnValue({ size: 4 });
    const payload = Buffer.from([0x1f, 0x8b, 0x08, 0x00]); // magic gzip
    fsMock.readFileSync.mockReturnValue(payload);
    const res = await app().request('/workflows/wf-1/runs/archive/runs-2026-06-a.jsonl.gz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('runs-2026-06-a.jsonl.gz');
    expect(res.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(payload);
  });
});
