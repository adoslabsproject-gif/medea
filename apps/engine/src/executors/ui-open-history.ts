/**
 * `ui_open_history` executor.
 *
 * Genera URL al Run History view del workflow, con query params filtri.
 * Pure function — no I/O, no API call.
 *
 * @module executors/ui-open-history
 */

import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@flowforge/nodes-stdlib';
import { loadConfig } from '@/config.js';

export const uiOpenHistoryExecutor: NodeExecutor = (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const workflowId = coerceString(cfg.workflowId ?? '').trim() || context.workflowId;
  const status = coerceString(cfg.statusFilter ?? 'all');
  const dateFrom = coerceString(cfg.dateFrom ?? '').trim();
  const dateTo = coerceString(cfg.dateTo ?? '').trim();
  const search = coerceString(cfg.searchQuery ?? '').trim();

  const runtime = loadConfig();
  const baseUrl = coerceString(cfg.baseUrl ?? '').trim()
    || runtime.FLOWFORGE_PUBLIC_BASE_URL
    || '';

  if (!baseUrl) {
    return Promise.reject(new Error('ui_open_history: nessun baseUrl disponibile. Imposta cfg.baseUrl o FLOWFORGE_PUBLIC_BASE_URL env.'));
  }

  const url = new URL(`${baseUrl.replace(/\/$/, '')}/`);
  url.searchParams.set('view', 'runs');
  url.searchParams.set('workflowId', workflowId);
  if (status && status !== 'all') url.searchParams.set('status', status);
  if (dateFrom) url.searchParams.set('from', dateFrom);
  if (dateTo) url.searchParams.set('to', dateTo);
  if (search) url.searchParams.set('q', search);

  return Promise.resolve({
    output: {
      url: url.toString(),
      workflowId,
      filters: {
        status: status === 'all' ? null : status,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        search: search || null,
      },
    },
    durationMs: Date.now() - start,
  });
};
