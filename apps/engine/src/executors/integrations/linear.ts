/**
 * Linear integration executor — issueCreate via GraphQL.
 *
 * Credentials: { apiKey: "lin_api_..." }
 *
 * @module executors/integrations/linear
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped } from '@/lib/capped-response.js';

const LINEAR_API = 'https://api.linear.app/graphql';

interface LinearCredentials { apiKey: string }

interface GqlResp<T> { data?: T; errors?: { message: string; extensions?: { code?: string } }[] }

async function gqlFetch<T>(apiKey: string, query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await safeOutboundFetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new IntegrationError({
      provider: 'linear', code: 'API_HTTP_ERROR',
      message: `Linear HTTP ${String(res.status)} ${res.statusText}`,
      httpStatus: res.status, retryable: res.status >= 500 || res.status === 429,
    });
  }
  const body = await readJsonCapped<GqlResp<T>>(res);
  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0]!;
    throw new IntegrationError({
      provider: 'linear', code: first.extensions?.code ?? 'GRAPHQL_ERROR',
      message: `Linear GraphQL: ${first.message}`,
    });
  }
  if (!body.data) throw new IntegrationError({
    provider: 'linear', code: 'EMPTY_RESPONSE', message: 'Linear GraphQL: response senza data',
  });
  return body.data;
}

export const linearExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const teamKey = coerceString(cfg.teamKey ?? '').trim().toUpperCase();
  const title = coerceString(cfg.title ?? '').trim();
  if (!teamKey) throw new IntegrationError({ provider: 'linear', code: 'INVALID_PAYLOAD', message: 'integration_linear_create_issue: "teamKey" obbligatorio' });
  if (!title) throw new IntegrationError({ provider: 'linear', code: 'INVALID_PAYLOAD', message: 'integration_linear_create_issue: "title" obbligatorio' });

  const integration = requireIntegration({
    provider: 'linear', tenantId: context.tenantId,
    label: typeof cfg.integrationLabel === 'string' && cfg.integrationLabel ? cfg.integrationLabel : null,
  });
  const creds = integration.credentials as unknown as LinearCredentials;
  if (!creds.apiKey?.startsWith('lin_api_')) {
    throw new IntegrationError({
      provider: 'linear', code: 'INVALID_CREDENTIALS',
      message: 'integration_linear_create_issue: apiKey non valido (formato: lin_api_*)',
    });
  }

  const warnings: string[] = [];

  // 1) Resolve teamId
  const teamData = await withRetry(() => gqlFetch<{ teams: { nodes: { id: string; key: string }[] } }>(
    creds.apiKey,
    'query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }',
    { key: teamKey },
    context.abortSignal,
  ), { label: 'linear.teams' });
  const team = teamData.teams.nodes[0];
  if (!team) throw new IntegrationError({
    provider: 'linear', code: 'TEAM_NOT_FOUND',
    message: `integration_linear_create_issue: team "${teamKey}" non trovato`,
  });

  // 2) Resolve assignee email → userId (best-effort)
  let assigneeId: string | undefined;
  const assigneeEmail = coerceString(cfg.assigneeEmail ?? '').trim();
  if (assigneeEmail) {
    try {
      const userData = await gqlFetch<{ users: { nodes: { id: string; email: string }[] } }>(
        creds.apiKey,
        'query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id email } } }',
        { email: assigneeEmail }, context.abortSignal,
      );
      const u = userData.users.nodes[0];
      if (u) assigneeId = u.id;
      else warnings.push(`Assignee "${assigneeEmail}" non trovato — issue creata unassigned`);
    } catch (e) {
      warnings.push(`Assignee lookup fallito: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3) Resolve label names → ids
  const labelIds: string[] = [];
  const labelNamesRaw = coerceString(cfg.labelNames ?? '').trim();
  if (labelNamesRaw) {
    const wanted = labelNamesRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    try {
      const labelData = await gqlFetch<{ team: { labels: { nodes: { id: string; name: string }[] } } }>(
        creds.apiKey,
        'query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }',
        { teamId: team.id }, context.abortSignal,
      );
      const allLabels = labelData.team.labels.nodes;
      for (const w of wanted) {
        const m = allLabels.find(l => l.name.toLowerCase() === w);
        if (m) labelIds.push(m.id);
        else warnings.push(`Label "${w}" non trovata nel team`);
      }
    } catch (e) {
      warnings.push(`Labels lookup fallito: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4) Create issue
  const priorityRaw = Number(cfg.priority ?? 0);
  const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.min(Math.floor(priorityRaw), 4)) : 0;
  const description = typeof cfg.description === 'string' ? cfg.description : undefined;

  const createData = await withRetry(() => gqlFetch<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string; title: string; state: { name: string } } } }>(
    creds.apiKey,
    `mutation($input: IssueCreateInput!) {
       issueCreate(input: $input) {
         success
         issue { id identifier url title state { name } }
       }
     }`,
    {
      input: {
        teamId: team.id,
        title,
        ...(description ? { description } : {}),
        priority,
        ...(assigneeId ? { assigneeId } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
      },
    }, context.abortSignal,
  ), { label: 'linear.issueCreate' });

  if (!createData.issueCreate.success) {
    throw new IntegrationError({
      provider: 'linear', code: 'CREATE_FAILED',
      message: 'integration_linear_create_issue: Linear ha rifiutato issueCreate (success=false)',
    });
  }
  const issue = createData.issueCreate.issue;

  return {
    output: {
      ok: true,
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      title: issue.title,
      state: issue.state.name,
      warnings,
    },
    durationMs: Date.now() - start,
  };
};
