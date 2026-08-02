/**
 * Auto-rendered HTML form endpoint.
 * For every workflow with a `trigger_form` node, the runtime renders a
 * styled HTML form at /forms/:workflowId/:token. POST submission triggers
 * the workflow with the form data as triggerInput.
 *
 * Rate-limited per IP via the form's `rateLimitPerMin` config.
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { CanvasNode, Workflow } from '@medea/engine-core-schema';
import { WorkflowService } from '@/services/workflow.service.js';
import { RunService } from '@/services/run.service.js';
import type { IEventBus } from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';
import { escapeHtml } from '@/lib/html-escape.js';

/**
 * Constant-time token comparison — protegge da timing attacks.
 * Restituisce true SOLO se le due stringhe coincidono completamente.
 * Se le lunghezze differiscono, ritorna false SENZA leak della lunghezza
 * vera (allochiamo buffer alla lunghezza dell'expected, poi comparison).
 */
function safeTokenCompare(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided.length === expected.length ? provided : expected);
  const lengthsMatch = expected.length === provided.length;
  // Esegui sempre il compare anche se le lunghezze sono diverse,
  // per non rivelare info via timing.
  const equal = timingSafeEqual(a, b);
  return lengthsMatch && equal;
}

interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date' | 'file';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  help?: string;
}

function findFormNode(workflow: Workflow): CanvasNode | undefined {
  return workflow.nodes.find((n) => n.defId === 'trigger_form');
}

function parseFields(fieldsJson: string | undefined): FormField[] {
  if (!fieldsJson) return [];
  try {
    const parsed = JSON.parse(fieldsJson) as unknown;
    return Array.isArray(parsed) ? (parsed as FormField[]) : [];
  } catch {
    return [];
  }
}

function renderField(field: FormField): string {
  const label = `<label class="block text-sm font-medium text-gray-700 mb-1" for="${escapeHtml(field.key)}">${escapeHtml(field.label)}${field.required ? ' <span class="text-red-500">*</span>' : ''}</label>`;
  const required = field.required ? 'required' : '';
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
  const help = field.help
    ? `<p class="mt-1 text-xs text-gray-500">${escapeHtml(field.help)}</p>`
    : '';
  const base =
    'class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"';

  let input: string;
  switch (field.type) {
    case 'textarea':
      input = `<textarea id="${escapeHtml(field.key)}" name="${escapeHtml(field.key)}" rows="4" ${base} ${required} ${placeholder}></textarea>`;
      break;
    case 'select':
      input = `<select id="${escapeHtml(field.key)}" name="${escapeHtml(field.key)}" ${base} ${required}>${(field.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`;
      break;
    case 'checkbox':
      input = `<input id="${escapeHtml(field.key)}" name="${escapeHtml(field.key)}" type="checkbox" class="h-4 w-4 rounded border-gray-300" ${required}>`;
      break;
    case 'file':
      input = `<input id="${escapeHtml(field.key)}" name="${escapeHtml(field.key)}" type="file" class="w-full text-sm" ${required}>`;
      break;
    default:
      input = `<input id="${escapeHtml(field.key)}" name="${escapeHtml(field.key)}" type="${field.type}" ${base} ${required} ${placeholder}>`;
  }
  return `<div class="mb-4">${label}${input}${help}</div>`;
}

function renderForm(opts: {
  title: string;
  submitLabel: string;
  fields: FormField[];
  action: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} — FlowForge</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center py-12">
<form method="POST" action="${escapeHtml(opts.action)}" enctype="multipart/form-data" class="w-full max-w-md bg-white rounded-xl shadow-lg p-8">
<h1 class="text-2xl font-bold text-gray-900 mb-1">${escapeHtml(opts.title)}</h1>
<p class="text-sm text-gray-500 mb-6">Powered by FlowForge</p>
${opts.fields.map(renderField).join('\n')}
<button type="submit" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2 px-4 rounded-md transition">${escapeHtml(opts.submitLabel)}</button>
</form>
</body>
</html>`;
}

function renderSuccess(message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Thank you</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
<div class="bg-white rounded-xl shadow-lg p-8 max-w-md text-center">
<div class="text-5xl text-green-500 mb-4">✓</div>
<p class="text-lg font-medium text-gray-800 mb-2">${escapeHtml(message)}</p>
<p class="text-sm text-gray-500">Powered by FlowForge</p>
</div></body></html>`;
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

export function createFormRoutes(eventBus: IEventBus): Hono {
  const app = new Hono();
  const workflows = new WorkflowService(eventBus);
  const runs = new RunService(eventBus);

  /**
   * Helper interno: trova workflow + nodo form, valida token in modo
   * timing-safe. Centralizza il check così GET e POST condividono la
   * stessa logica e nessuno dei due può accidentalmente saltarla.
   *
   * Restituisce { ok: true, workflow, node, tenantId } se l'auth passa,
   * altrimenti { ok: false, status, message } per la response 4xx.
   */
  async function authFormRequest(
    workflowId: string,
    token: string,
  ): Promise<
    | { ok: true; workflow: Workflow; node: CanvasNode; tenantId: string }
    | { ok: false; status: 400 | 403 | 404 | 410; message: string }
  > {
    if (!workflowId || !token) return { ok: false, status: 400, message: 'Bad request' };
    const workflow = await workflows.getByIdAnyTenant(workflowId);
    if (!workflow) return { ok: false, status: 404, message: 'Form not found' };
    const node = findFormNode(workflow);
    if (!node) return { ok: false, status: 404, message: 'Workflow has no form trigger' };
    const expectedToken =
      typeof node.config.publicToken === 'string' ? node.config.publicToken : '';
    // Se il workflow non ha publicToken configurato (es. workflow legacy
    // creati prima del fix sicurezza 2026-05-23), rifiutiamo l'accesso.
    // L'utente deve aprire l'editor, salvare il workflow (il backend
    // auto-genera il token), e condividere il nuovo URL.
    if (!expectedToken) {
      return {
        ok: false,
        status: 410,
        message:
          "Form non configurato per submission pubblica. Apri l'editor, salva il workflow per generare il token, poi ri-condividi il nuovo URL.",
      };
    }
    if (!safeTokenCompare(expectedToken, token)) {
      logger.warn(
        { workflowId, ip: 'redacted' },
        'forms: invalid token (potential enumeration attempt)',
      );
      return { ok: false, status: 403, message: 'Forbidden' };
    }
    return { ok: true, workflow, node, tenantId: workflow.tenantId ?? 'default' };
  }

  app.get('/:workflowId/:token', async (c) => {
    const workflowId = c.req.param('workflowId');
    const token = c.req.param('token');
    const auth = await authFormRequest(workflowId, token);
    if (!auth.ok) return c.text(auth.message, auth.status);
    const { node } = auth;
    const fields = parseFields(node.config.fieldsJson);
    const html = renderForm({
      title: node.config.title ?? 'New submission',
      submitLabel: node.config.submitLabel ?? 'Submit',
      fields,
      action: c.req.url,
    });
    return c.html(html);
  });

  app.post('/:workflowId/:token', async (c) => {
    const workflowId = c.req.param('workflowId');
    const token = c.req.param('token');
    const auth = await authFormRequest(workflowId, token);
    if (!auth.ok) return c.text(auth.message, auth.status);
    const { node, tenantId } = auth;

    const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';
    const limit = Number(node.config.rateLimitPerMin ?? 10);
    if (!rateLimit(`${workflowId}:${ip}`, limit)) {
      return c.text('Too many submissions, please try again later.', 429);
    }

    const form = await c.req.formData();
    const data: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      data[k] = typeof v === 'string' ? v : '[file]';
    }

    try {
      await runs.execute({
        workflowId,
        triggerType: 'form',
        triggerInput: data,
        tenantId,
      });
    } catch (error) {
      logger.error({ err: error, workflowId }, 'Form-triggered run failed');
    }

    return c.html(
      renderSuccess(node.config.successMessage ?? 'Thank you! Your submission was received.'),
    );
  });

  return app;
}
