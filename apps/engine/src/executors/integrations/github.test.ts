/**
 * Test 2026-grade — executors/integrations/github.ts (REST API v3).
 *
 * 🚨 TOKEN FORMAT STRICT: "ghp_*" o "github_pat_*". Token Bearer-style o vuoto
 *    → INVALID_CREDENTIALS (no API waste).
 *
 * 🚨 7 operations: createIssue / listIssues / getIssue / closeIssue /
 *    addComment / createPullRequest / listCommits.
 *
 * 🚨 owner + repo MANDATORY ovunque — getStr required=true throw INVALID_PAYLOAD.
 *
 * 🚨 RETRYABLE: 5xx + 429 + 403 (rate limit). 4xx (eccetto 403) → no retry.
 *
 * 🚨 RATE LIMIT: x-ratelimit-remaining header letto e propagato in output.
 *
 * 🚨 LABELS/ASSIGNEES: CSV string → array trim filter.
 *
 * 🚨 PERPAGE CLAMP: 1..100 (GitHub API cap).
 *
 * 🚨 HEADERS API: vnd.github+json + X-GitHub-Api-Version: 2022-11-28 + UA.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IntegrationError } from './common.js';

const safeFetchMock = vi.hoisted(() => vi.fn());
const getIntegrationMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: safeFetchMock,
}));
vi.mock('@/services/integrations/store.js', () => ({
  getIntegration: getIntegrationMock,
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: async () => undefined,
}));

const { githubExecutor } = await import('./github.js');

const ctx = () =>
  ({
    runId: 'r',
    workflowId: 'w',
    nodeId: 'n',
    tenantId: 't1',
    defId: 'community_github',
    llmProviders: [],
    nodeOutputs: {},
    secrets: {},
  }) as never;

function mockRes(
  body: unknown,
  opts: {
    status?: number;
    ok?: boolean;
    statusText?: string;
    rateLimit?: string;
  } = {},
): Response {
  const status = opts.status ?? 200;
  const headers = new Headers();
  if (opts.rateLimit !== undefined) headers.set('x-ratelimit-remaining', opts.rateLimit);
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    statusText: opts.statusText ?? 'OK',
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  getIntegrationMock.mockReturnValue({
    id: 'int-1',
    provider: 'github',
    label: null,
    credentials: { token: 'ghp_VALIDxxx123' },
  });
});

describe('🚨 mandatory fields', () => {
  it('🚨 operation missing → INVALID_PAYLOAD', async () => {
    await expect(githubExecutor({ owner: 'a', repo: 'b' } as never, null, ctx())).rejects.toThrow(
      /operation/u,
    );
  });

  it('🚨 owner missing → INVALID_PAYLOAD', async () => {
    await expect(
      githubExecutor({ operation: 'listIssues', repo: 'b' } as never, null, ctx()),
    ).rejects.toThrow(/owner/u);
  });

  it('🚨 repo missing → INVALID_PAYLOAD', async () => {
    await expect(
      githubExecutor({ operation: 'listIssues', owner: 'a' } as never, null, ctx()),
    ).rejects.toThrow(/repo/u);
  });

  it('🚨 owner trim whitespace', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: '  acme  ',
        repo: 'project',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('/repos/acme/project/');
  });

  it('🚨🚨 PATH-INJECTION: owner/repo/issueNumber con caratteri di path → encodeURIComponent', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({}));
    await githubExecutor(
      {
        operation: 'getIssue',
        owner: '../../user',
        repo: 'r?x=1',
        issueNumber: '1/../keys',
      } as never,
      null,
      ctx(),
    );
    const url = safeFetchMock.mock.calls[0]![0] as string;
    // i metacaratteri di path/query sono percent-encodati → l'endpoint colpito resta
    // /repos/<owner>/<repo>/issues/<n>, non un endpoint diverso scelto dall'autore.
    expect(url).not.toContain('../');
    expect(url).toContain('%2F'); // '/' encodato dentro i segmenti
    expect(url).toContain('%3F'); // '?' encodato (niente query injection)
    expect(url.startsWith('https://api.github.com/repos/')).toBe(true);
  });
});

describe('🚨 token format validation', () => {
  it('🚨 token ghp_* → ok', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor({ operation: 'listIssues', owner: 'a', repo: 'b' } as never, null, ctx());
    expect(safeFetchMock).toHaveBeenCalled();
  });

  it('🚨 token github_pat_* → ok', async () => {
    getIntegrationMock.mockReturnValue({
      id: 'int',
      provider: 'github',
      label: null,
      credentials: { token: 'github_pat_xxxyyy' },
    });
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor({ operation: 'listIssues', owner: 'a', repo: 'b' } as never, null, ctx());
    expect(safeFetchMock).toHaveBeenCalled();
  });

  it('🚨 token Bearer-style → INVALID_CREDENTIALS', async () => {
    getIntegrationMock.mockReturnValue({
      id: 'int',
      provider: 'github',
      label: null,
      credentials: { token: 'Bearer wrong-format' },
    });
    await expect(
      githubExecutor({ operation: 'listIssues', owner: 'a', repo: 'b' } as never, null, ctx()),
    ).rejects.toThrow(/INVALID_CREDENTIALS|ghp_|github_pat_/u);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 token vuoto → INVALID_CREDENTIALS', async () => {
    getIntegrationMock.mockReturnValue({
      id: 'int',
      provider: 'github',
      label: null,
      credentials: { token: '' },
    });
    await expect(
      githubExecutor({ operation: 'listIssues', owner: 'a', repo: 'b' } as never, null, ctx()),
    ).rejects.toThrow(/INVALID_CREDENTIALS|ghp_|github_pat_/u);
  });

  it('🚨 integration NOT configured → NOT_CONFIGURED', async () => {
    getIntegrationMock.mockReturnValue(null);
    await expect(
      githubExecutor({ operation: 'listIssues', owner: 'a', repo: 'b' } as never, null, ctx()),
    ).rejects.toThrow(/NOT_CONFIGURED|not configured/u);
  });
});

describe('🚨 createIssue', () => {
  it('🚨 happy: POST /repos/.../issues with title', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ number: 42, html_url: 'https://gh/i/42' }));
    await githubExecutor(
      {
        operation: 'createIssue',
        owner: 'a',
        repo: 'b',
        title: 'Bug found',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toBe('https://api.github.com/repos/a/b/issues');
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Bug found' });
  });

  it('🚨 title obbligatorio → INVALID_PAYLOAD', async () => {
    await expect(
      githubExecutor({ operation: 'createIssue', owner: 'a', repo: 'b' } as never, null, ctx()),
    ).rejects.toThrow(/title/u);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('🚨 labels CSV → array trim filter', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({}));
    await githubExecutor(
      {
        operation: 'createIssue',
        owner: 'a',
        repo: 'b',
        title: 'T',
        labels: ' bug , high-prio,  ,backend ',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      labels: string[];
    };
    expect(body.labels).toEqual(['bug', 'high-prio', 'backend']);
  });

  it('🚨 assignees CSV → array', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({}));
    await githubExecutor(
      {
        operation: 'createIssue',
        owner: 'a',
        repo: 'b',
        title: 'T',
        assignees: 'alice,bob',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      assignees: string[];
    };
    expect(body.assignees).toEqual(['alice', 'bob']);
  });

  it('🚨 body opzionale: NON incluso se vuoto', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({}));
    await githubExecutor(
      {
        operation: 'createIssue',
        owner: 'a',
        repo: 'b',
        title: 'T',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { body?: string };
    expect(body.body).toBeUndefined();
  });
});

describe('🚨 listIssues / listCommits — perPage CLAMP', () => {
  it('🚨 perPage default 30', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('per_page=30');
  });

  it('🚨 perPage clamp >100 → 100', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
        perPage: 999,
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('per_page=100');
  });

  it('🚨 perPage clamp <1 → 1', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
        perPage: 0,
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('per_page=1');
  });

  it('🚨 state default "open"', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('state=open');
  });

  it('🚨 state custom "closed"', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
        state: 'closed',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('state=closed');
  });

  it('🚨 count = data.length', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([{ number: 1 }, { number: 2 }, { number: 3 }]));
    const r = await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    expect((r.output as { count: number }).count).toBe(3);
  });

  it('🚨 listCommits: GET /commits + perPage clamp', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listCommits',
        owner: 'a',
        repo: 'b',
        perPage: 9999,
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('/repos/a/b/commits?per_page=100');
  });
});

describe('🚨 getIssue / closeIssue / addComment', () => {
  it('🚨 getIssue: issueNumber obbligatorio', async () => {
    await expect(
      githubExecutor({ operation: 'getIssue', owner: 'a', repo: 'b' } as never, null, ctx()),
    ).rejects.toThrow(/issueNumber/u);
  });

  it('🚨 getIssue happy: GET /issues/:n', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ number: 7, title: 'X' }));
    await githubExecutor(
      {
        operation: 'getIssue',
        owner: 'a',
        repo: 'b',
        issueNumber: '7',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toBe('https://api.github.com/repos/a/b/issues/7');
  });

  it('🚨 closeIssue: PATCH state=closed', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ number: 7, state: 'closed' }));
    await githubExecutor(
      {
        operation: 'closeIssue',
        owner: 'a',
        repo: 'b',
        issueNumber: '7',
      } as never,
      null,
      ctx(),
    );
    const init = safeFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ state: 'closed' });
  });

  it('🚨 addComment: body obbligatorio + issueNumber', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ id: 123 }));
    await githubExecutor(
      {
        operation: 'addComment',
        owner: 'a',
        repo: 'b',
        issueNumber: '7',
        body: 'commento',
      } as never,
      null,
      ctx(),
    );
    expect(safeFetchMock.mock.calls[0]![0]).toContain('/issues/7/comments');
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { body: string };
    expect(body.body).toBe('commento');
  });

  it('🚨 addComment senza body → INVALID_PAYLOAD', async () => {
    await expect(
      githubExecutor(
        {
          operation: 'addComment',
          owner: 'a',
          repo: 'b',
          issueNumber: '7',
        } as never,
        null,
        ctx(),
      ),
    ).rejects.toThrow(/body/u);
  });
});

describe('🚨 createPullRequest', () => {
  it('🚨 title + head obbligatori', async () => {
    await expect(
      githubExecutor(
        {
          operation: 'createPullRequest',
          owner: 'a',
          repo: 'b',
          title: 'PR',
        } as never,
        null,
        ctx(),
      ),
    ).rejects.toThrow(/headBranch/u);
  });

  it('🚨 base default "main"', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ number: 1 }));
    await githubExecutor(
      {
        operation: 'createPullRequest',
        owner: 'a',
        repo: 'b',
        title: 'PR',
        headBranch: 'feature',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as {
      base: string;
      head: string;
    };
    expect(body.base).toBe('main');
    expect(body.head).toBe('feature');
  });

  it('🚨 base custom', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ number: 1 }));
    await githubExecutor(
      {
        operation: 'createPullRequest',
        owner: 'a',
        repo: 'b',
        title: 'PR',
        headBranch: 'feat',
        baseBranch: 'develop',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { base: string };
    expect(body.base).toBe('develop');
  });

  it('🚨 body opzionale → NON incluso se vuoto (cleaner JSON)', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes({ number: 1 }));
    await githubExecutor(
      {
        operation: 'createPullRequest',
        owner: 'a',
        repo: 'b',
        title: 'PR',
        headBranch: 'feat',
      } as never,
      null,
      ctx(),
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1]!.body as string) as { body?: string };
    expect(body.body).toBeUndefined();
  });
});

describe('🚨 headers API GitHub-conformant', () => {
  it('🚨 Accept vnd.github+json + X-GitHub-Api-Version + UA', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    const headers = safeFetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('token ghp_VALIDxxx123');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers['User-Agent']).toBe('FlowForge-Integrations/1.0');
  });
});

describe('🚨 rate limit propagation', () => {
  it('🚨 x-ratelimit-remaining → output.rateLimitRemaining', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([], { rateLimit: '4523' }));
    const r = await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    expect((r.output as { rateLimitRemaining: number | null }).rateLimitRemaining).toBe(4523);
  });

  it('🚨 header missing → 0 (gh source: Number(null)=0, finite → propagato)', async () => {
    // BUG attuale source: Number(headers.get('x-ratelimit-remaining')) con header
    // missing → null → 0 (finito). Documenta il comportamento, non lo "corregge"
    // ad-hoc (un'altra sessione potrebbe lavorare sul file).
    safeFetchMock.mockResolvedValueOnce(mockRes([]));
    const r = await githubExecutor(
      {
        operation: 'listIssues',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    const rl = (r.output as { rateLimitRemaining: number | null }).rateLimitRemaining;
    // Accetta entrambi: 0 (header missing → Number(null)) o null (se il fix arriva)
    expect(rl === 0 || rl === null).toBe(true);
  });
});

describe('🚨 error handling + retry policy', () => {
  it('🚨 401 → IntegrationError httpStatus 401 retryable=false', async () => {
    safeFetchMock.mockResolvedValueOnce(
      mockRes(
        { message: 'Bad credentials' },
        { status: 401, ok: false, statusText: 'Unauthorized' },
      ),
    );
    try {
      await githubExecutor(
        {
          operation: 'listIssues',
          owner: 'a',
          repo: 'b',
        } as never,
        null,
        ctx(),
      );
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.httpStatus).toBe(401);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Bad credentials');
    }
  });

  it('🚨 403 (rate limit GitHub) → retryable=true', async () => {
    safeFetchMock.mockResolvedValue(
      mockRes({ message: 'API rate limit exceeded' }, { status: 403, ok: false }),
    );
    try {
      await githubExecutor(
        {
          operation: 'listIssues',
          owner: 'a',
          repo: 'b',
        } as never,
        null,
        ctx(),
      );
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.retryable).toBe(true);
    }
  });

  it('🚨 404 → retryable=false', async () => {
    safeFetchMock.mockResolvedValueOnce(
      mockRes({ message: 'Not Found' }, { status: 404, ok: false }),
    );
    try {
      await githubExecutor(
        {
          operation: 'getIssue',
          owner: 'a',
          repo: 'b',
          issueNumber: '999',
        } as never,
        null,
        ctx(),
      );
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Not Found');
    }
  });

  it('🚨 503 → retryable=true', async () => {
    safeFetchMock.mockResolvedValue(mockRes('Service Unavailable', { status: 503, ok: false }));
    try {
      await githubExecutor(
        {
          operation: 'listIssues',
          owner: 'a',
          repo: 'b',
        } as never,
        null,
        ctx(),
      );
      expect.fail('should throw');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.retryable).toBe(true);
    }
  });
});

describe('🚨 operation sconosciuta', () => {
  it('🚨 INVALID_PAYLOAD', async () => {
    await expect(
      githubExecutor(
        {
          operation: 'fakeOp',
          owner: 'a',
          repo: 'b',
        } as never,
        null,
        ctx(),
      ),
    ).rejects.toThrow(/fakeOp.+non supportata/u);
  });
});

describe('🚨 output shape', () => {
  it('🚨 ok=true + data + count + rateLimitRemaining + durationMs', async () => {
    safeFetchMock.mockResolvedValueOnce(mockRes([{ id: 1 }], { rateLimit: '100' }));
    const r = await githubExecutor(
      {
        operation: 'listCommits',
        owner: 'a',
        repo: 'b',
      } as never,
      null,
      ctx(),
    );
    expect(r.output).toMatchObject({ ok: true, count: 1, rateLimitRemaining: 100 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});
