/**
 * MCP (Model Context Protocol) bridge.
 *
 * Exposes every enabled workflow as an MCP tool. LLM clients (Claude Desktop,
 * Cursor, Continue, Cline, etc.) discover tools via `tools/list` and invoke
 * them via `tools/call`. Each workflow's input/output schemas are derived
 * from its trigger / last-action shape.
 *
 * Endpoints (JSON-RPC 2.0 over POST /api/v1/mcp):
 *   - initialize
 *   - tools/list
 *   - tools/call    →  forwards to RunService.execute and returns the terminal node output
 *
 * Auth: same session JWT as the rest of the runtime — tenants are isolated.
 *
 * n8n shipped MCP only in mid-2025 — FlowForge exposes EVERY workflow
 * automatically, no per-tool config needed.
 */

import { Hono } from 'hono';
import { RunService } from '@/services/run.service.js';
import { WorkflowService } from '@/services/workflow.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { getTenantId } from '@/lib/tenant.js';
import { safeParseJson } from '@/lib/safe-parse-json.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'flowforge-mcp', version: '0.1.0' };

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

export function createMcpRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const runs = new RunService(eventBus);
  const workflows = new WorkflowService(eventBus);

  app.post('/mcp', async (c) => {
    const tenantId = getTenantId(c);
    // c.req.json() throws su body non-JSON / malformato. Cattura per
    // ritornare JSON-RPC parse error standard (-32700) invece di 500 Hono.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
    }
    if (!raw || typeof raw !== 'object') {
      return c.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } });
    }
    const req = raw as JsonRpcRequest;
    const reply: JsonRpcResponse = { jsonrpc: '2.0' };
    if (req.id !== undefined) reply.id = req.id;

    try {
      if (req.method === 'initialize') {
        reply.result = {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false } },
        };
        return c.json(reply);
      }

      if (req.method === 'tools/list') {
        // AUDIT FIX WE-9 (2026-06-09 HIGH): SOLO workflow con mcp_exposed=1.
        // Pre-fix: tutti i workflow enabled del tenant esposti a chiunque
        // autenticato → ACL bypass (workflow admin destruction invokable
        // da editor). Post-fix: opt-in esplicito (default disabled).
        const list = await workflows.listMcpExposed(tenantId);
        const tools = list.map((w) => ({
          name: `wf_${slug(w.name)}_${w.id.slice(0, 8)}`,
          description: w.description ?? `FlowForge workflow: ${w.name}`,
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'object', description: 'Trigger payload passed to the workflow.' },
            },
            additionalProperties: false,
          },
          _flowforge: { workflowId: w.id, tenantId },
        }));
        reply.result = { tools };
        return c.json(reply);
      }

      if (req.method === 'tools/call') {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
        if (!name) {
          reply.error = { code: -32602, message: 'Invalid params: missing name' };
          return c.json(reply);
        }

        // AUDIT FIX WE-9 (2026-06-09 HIGH): resolve name → wf_id usando
        // listMcpExposed (solo opt-in). + double-check isMcpExposed prima
        // dell'esecuzione (defense-in-depth contro race in cui il workflow
        // è stato disabilitato tra list e call).
        const list = await workflows.listMcpExposed(tenantId);
        const match = list.find((w) => `wf_${slug(w.name)}_${w.id.slice(0, 8)}` === name);
        if (!match) {
          reply.error = { code: -32601, message: `Tool not found: ${name}` };
          return c.json(reply);
        }
        // Re-check exposure right before execute (toctou-safe)
        const stillExposed = await workflows.isMcpExposed(match.id, tenantId);
        if (!stillExposed) {
          reply.error = { code: -32601, message: `Tool not found: ${name}` };
          return c.json(reply);
        }

        const result = await runs.execute({
          workflowId: match.id,
          tenantId,
          triggerType: 'mcp',
          triggerInput: args.input ?? args,
        });

        if (result.status !== 'success') {
          const failed = (
            result.steps as { nodeId: string; status: string; error?: string | null }[]
          ).find((s) => s.status === 'error');
          reply.result = {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Workflow failed at ${failed?.nodeId ?? 'unknown'}: ${failed?.error ?? 'unknown error'}`,
              },
            ],
          };
          return c.json(reply);
        }

        const successSteps = (result.steps as { status: string; output: string }[]).filter(
          (s) => s.status === 'success',
        );
        const last = successSteps[successSteps.length - 1];
        const parsed = safeParseJson(last?.output);

        reply.result = {
          content: [
            typeof parsed === 'string'
              ? { type: 'text', text: parsed }
              : { type: 'text', text: JSON.stringify(parsed, null, 2) },
          ],
        };
        return c.json(reply);
      }

      reply.error = { code: -32601, message: `Method not found: ${req.method}` };
      return c.json(reply);
    } catch (err) {
      logger.error({ err, method: req.method }, 'MCP request failed');
      reply.error = { code: -32603, message: err instanceof Error ? err.message : String(err) };
      return c.json(reply);
    }
  });

  return app;
}
