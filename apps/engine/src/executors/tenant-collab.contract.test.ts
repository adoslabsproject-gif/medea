/**
 * Contract test CROSS-LATO — il cuore anti-regressione del bridge cross-tenant:
 *
 *   MITTENTE (tenantCollabExecutor, request REALE catturata)
 *        ↓ headers + body
 *   RICEVENTE (authorize() REALE di routes/webhooks.ts, config documentata)
 *
 * Se uno dei due lati cambia formato firma (header, ts.body, algo) o la
 * documentazione del NodeDef smette di dire al destinatario come configurarsi,
 * questo test si rompe SUBITO — invece di lasciare due tenant in produzione a
 * parlarsi nel vuoto con 401.
 *
 * Pinna anche: i 3 punti di registrazione del nodo e il contratto
 * def.configFields ↔ chiavi lette dall'executor.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@/lib/logger.js');
vi.mock('@/services/workflow.service.js', () => ({ WorkflowService: class {} }));
vi.mock('@/services/run.service.js', () => ({ RunService: class {} }));
vi.mock('@/lib/safe-parse-json.js', () => ({ safeParseJson: vi.fn() }));
vi.mock('@/executors/wait.js', () => ({ resumeWait: vi.fn() }));
vi.mock('@/services/test-event-bus.service.js', () => ({ publishTestEvent: vi.fn() }));
vi.mock('@/executors/webhook-respond.js', () => ({ WEBHOOK_RESPONSE_KEY: 'response' }));
vi.mock('@/services/audit.service.js', () => ({
  AuditLogService: class {
    append = vi.fn().mockResolvedValue(undefined);
  },
}));

import { authorize, __resetWebhookSignatureCache } from '../routes/webhooks.js';
import { tenantCollabExecutor } from './tenant-collab.js';
import {
  COLLAB_SIGNATURE_HEADER,
  COLLAB_TIMESTAMP_HEADER,
  signCollabPayload,
} from './tenant-collab-protocol.js';
import { tenantCollabNode } from '@medea/engine-nodes-stdlib';
import type { CanvasNode } from '@medea/engine-core-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf-8');

const TOKEN = 'collab-shared-token-0123456789abcdef';
const URL_OK = 'https://beta.app.automazionezeli.com/api/v1/webhooks/wf-dest/whtok-9f8e7d6c';

/** La config del trigger Webhook ESATTAMENTE come la documentiamo al destinatario nel def. */
function recipientNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'wh-recipient',
    type: 'trigger_webhook',
    config: {
      authMode: 'hmac-signature',
      hmacSecret: TOKEN,
      hmacHeader: COLLAB_SIGNATURE_HEADER,
      hmacTimestampHeader: COLLAB_TIMESTAMP_HEADER,
      ...extra,
    },
  } as unknown as CanvasNode;
}

const ctx = {
  tenantId: 'tenant-sender',
  workflowId: 'wf-src',
  runId: 'run-c1',
  nodeId: 'node-c1',
  defId: 'action_tenant_collab',
  secrets: {},
} as unknown as Parameters<typeof tenantCollabExecutor>[2];

/** Invia col MITTENTE reale e cattura la request come la vedrebbe Hono (header lowercase). */
async function captureRealSend(): Promise<{ headers: Record<string, string>; body: string }> {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 202 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await tenantCollabExecutor(
    { collaborationUrl: URL_OK, connectionToken: TOKEN, payloadJson: '{"order":42,"amount":99.5}' },
    {},
    ctx,
  );
  const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string>; body: string };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = v;
  return { headers, body: init.body };
}

const origFetch = globalThis.fetch;
beforeEach(() => {
  __resetWebhookSignatureCache();
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('handshake REALE mittente → authorize() ricevente', () => {
  it('la request firmata dal mittente è ACCETTATA dal ricevente configurato come da docs', async () => {
    const { headers, body } = await captureRealSend();
    expect(
      authorize(recipientNode(), headers, body, 'whtok-9f8e7d6c', '203.0.113.7', 'wf-dest'),
    ).toBe(true);
  });

  it('body manomesso in transito → RIFIUTATO', async () => {
    const { headers, body } = await captureRealSend();
    const tampered = body.replace('99.5', '9999.5');
    expect(
      authorize(recipientNode(), headers, tampered, 'whtok-9f8e7d6c', '203.0.113.7', 'wf-dest'),
    ).toBe(false);
  });

  it('replay della stessa request firmata → RIFIUTATO la seconda volta (dedup)', async () => {
    const { headers, body } = await captureRealSend();
    expect(
      authorize(recipientNode(), headers, body, 'whtok-9f8e7d6c', '203.0.113.7', 'wf-dest'),
    ).toBe(true);
    expect(
      authorize(recipientNode(), headers, body, 'whtok-9f8e7d6c', '203.0.113.7', 'wf-dest'),
    ).toBe(false);
  });

  it('token diverso lato ricevente (consenso revocato/ruotato) → RIFIUTATO', async () => {
    const { headers, body } = await captureRealSend();
    const node = recipientNode({ hmacSecret: 'ruotato-0123456789abcdefdiverso' });
    expect(authorize(node, headers, body, 'whtok-9f8e7d6c', '203.0.113.7', 'wf-dest')).toBe(false);
  });

  it('timestamp fuori finestra ±300s → RIFIUTATO (anti-replay differito)', () => {
    const body = '{"order":42}';
    for (const skewSec of [-400, 400]) {
      const ts = Math.floor(Date.now() / 1000) + skewSec;
      const sig = signCollabPayload({ body, token: TOKEN, timestampSec: ts });
      const headers = { [COLLAB_SIGNATURE_HEADER]: sig, [COLLAB_TIMESTAMP_HEADER]: String(ts) };
      expect(authorize(recipientNode(), headers, body, 'x', '203.0.113.7', 'wf-dest')).toBe(false);
    }
  });

  it('header firma/timestamp lowercase: Hono normalizza, le costanti DEVONO già esserlo', () => {
    expect(COLLAB_SIGNATURE_HEADER).toBe(COLLAB_SIGNATURE_HEADER.toLowerCase());
    expect(COLLAB_TIMESTAMP_HEADER).toBe(COLLAB_TIMESTAMP_HEADER.toLowerCase());
  });
});

describe('contratto def ↔ executor ↔ registrazione (3 punti)', () => {
  const executorSrc = read('./tenant-collab.ts');
  const runtimeRegistrySrc = read('./registry.ts');
  const stdlibRegistrySrc = read('../../../../packages/engine/nodes/stdlib/src/registry.ts');
  const stdlibIndexSrc = read('../../../../packages/engine/nodes/stdlib/src/index.ts');

  it("ogni configField del def è letto dall'executor (cfg.<key>) — zero campi fantasma", () => {
    const keys = (tenantCollabNode.def.configFields ?? []).map((f) => f.key);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const key of keys) {
      expect(executorSrc, `executor non legge cfg.${key}`).toMatch(new RegExp(`cfg\\.${key}\\b`));
    }
  });

  it('punto 1 — executors/registry.ts mappa action_tenant_collab → tenantCollabExecutor', () => {
    expect(runtimeRegistrySrc).toMatch(/action_tenant_collab:\s*tenantCollabExecutor/);
  });

  it('punti 2+3 — stdlib registry.ts include il nodo e index.ts lo esporta', () => {
    expect(stdlibRegistrySrc).toMatch(
      /import \{ tenantCollabNode \} from '\.\/actions\/tenant-collab\.js'/,
    );
    expect(stdlibRegistrySrc).toMatch(/\btenantCollabNode,/);
    expect(stdlibIndexSrc).toMatch(
      /export \{ tenantCollabNode \} from '\.\/actions\/tenant-collab\.js'/,
    );
  });

  // Il quarto punto di registrazione — il catalog generato del portal web —
  // qui non esiste: Medea non ha un portal, il catalogo dei nodi lo costruisce
  // il desktop da `features/workflows/catalog/`. Il controllo è stato tolto il
  // 2026-08-02 insieme agli altri riferimenti al monorepo di provenienza.

  it('la description del def DOCUMENTA la config del ricevente (help in-workspace auto)', () => {
    const desc = tenantCollabNode.def.description;
    expect(desc).toContain('hmac-signature');
    expect(desc).toContain(COLLAB_SIGNATURE_HEADER);
    expect(desc).toContain(COLLAB_TIMESTAMP_HEADER);
    expect(desc.length).toBeGreaterThan(150);
  });

  it('il pattern UI del campo collaborationUrl accetta solo webhook FlowForge', () => {
    const field = (tenantCollabNode.def.configFields ?? []).find(
      (f) => f.key === 'collaborationUrl',
    );
    expect(field?.pattern).toBeTruthy();
    const re = new RegExp(field!.pattern!);
    expect(re.test(URL_OK)).toBe(true);
    expect(re.test('https://evil.com/api/v1/webhooks/wf/t')).toBe(false);
    expect(re.test('https://acme.app.automazionezeli.com/api/v1/admin/x')).toBe(false);
  });
});
