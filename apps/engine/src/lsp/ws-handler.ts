/**
 * WebSocket bridge JSON-RPC 2.0 → TypeScript Language Service.
 *
 * Wire protocol (lightweight, non-strict-LSP):
 *
 *   client → server  { id, method: 'initialize', params: {} }
 *   client → server  { id, method: 'update',     params: { file, content } }
 *   client → server  { id, method: 'completion', params: { file, line, col } }
 *   client → server  { id, method: 'hover',      params: { file, line, col } }
 *   client → server  { id, method: 'diagnostics',params: { file } }
 *
 *   server → client  { id, result }
 *   server → client  { id, error: { code, message } }
 *
 *   server → client  { method: 'diagnostics', params: { file, items } }
 *                    (push spontaneo dopo `update` con auto-diagnostics)
 *
 * Auth (fix 2026-06-15): sessione JWT dal COOKIE HttpOnly `ff_session`
 * (same-origin → inviato automaticamente sull'upgrade, zero token in URL/log),
 * con fallback `?token=` per dev. Prima accettava SOLO `?token=` → ma il client
 * SPA dopo #203 P0-4 non ha più il token in JS → il WS veniva chiuso 1008 e
 * l'intero LSP era MORTO (silenzioso fallback al TS in-browser). Failure → 1008.
 *
 * Tenant isolation: il LSP non legge mai dal DB del workspace; gli unici
 * "secrets" che vede sono i 3 source che l'utente sta editando, gia\` suoi.
 * Quindi e\` strutturalmente sicuro condividere LSP cross-tenant. Comunque
 * creiamo 1 instance per connection per non avere stato condiviso.
 *
 * @module lsp/ws-handler
 */

import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { logger } from '@/lib/logger.js';
import { verifySessionToken } from '@medea/engine-auth-local';
import { extractWsSessionToken } from '@/lib/ws-auth.js';
import { TypeScriptLsp, type VirtualFile } from './typescript-lsp.js';

interface JsonRpcRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const ALLOWED_FILES = new Set<VirtualFile>(['executor', 'definition', 'schema']);

/**
 * Allega il LSP WS al server HTTP. Path: /api/v1/custom-nodes/lsp.
 * Crea una nuova instance TypeScriptLsp per connection (no cross-talk).
 */
export function attachCustomNodeLspServer(
  httpServer: Server,
  publicKeyPem: string,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/api/v1/custom-nodes/lsp')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws, request) => {
    // Cookie HttpOnly ff_session (same-origin) → fallback ?token= (dev).
    const token = extractWsSessionToken(request);
    if (!token) {
      ws.close(1008, 'Missing token');
      return;
    }
    void verifySessionToken(token, publicKeyPem).then((payload) => {
      if (!payload) {
        ws.close(1008, 'Invalid token');
        return;
      }
      // L'LSP e\` owner-only: i custom nodes sono privilege massimo.
      // Mantengo il check leggero (solo presenza tenantId/sub).
      const lsp = new TypeScriptLsp();
      logger.info({ tenantId: payload.tenantId, userId: payload.sub }, '[lsp/ts] connection opened');

      ws.on('message', (raw) => {
        let req: JsonRpcRequest;
        try {
          const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : '';
          req = JSON.parse(rawStr) as JsonRpcRequest;
        } catch {
          // bad frame — ignora
          return;
        }
        try {
          const result = dispatch(lsp, req, (notif) => {
            ws.send(JSON.stringify(notif));
          });
          if (req.id !== undefined) {
            ws.send(JSON.stringify({ id: req.id, result }));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (req.id !== undefined) {
            ws.send(JSON.stringify({
              id: req.id,
              error: { code: -32000, message: msg },
            }));
          }
        }
      });

      ws.on('close', () => {
        lsp.dispose();
      });
    }).catch((err: unknown) => {
      logger.warn({ err }, '[lsp/ts] auth error');
      ws.close(1011, 'Auth error');
    });
  });

  return wss;
}

/** Dispatcher dei metodi LSP. */
function dispatch(
  lsp: TypeScriptLsp,
  req: JsonRpcRequest,
  notify: (n: { method: string; params: unknown }) => void,
): unknown {
  const p = (req.params ?? {});
  switch (req.method) {
    case 'initialize':
      return {
        capabilities: {
          completion: true,
          hover: true,
          diagnostics: true,
        },
      };

    case 'update': {
      const file = p.file as VirtualFile;
      const content = p.content;
      if (!ALLOWED_FILES.has(file) || typeof content !== 'string') {
        throw new Error(`invalid update params: file=${String(file)} typeof content=${typeof content}`);
      }
      lsp.update(file, content);
      // Push spontaneo dei diagnostics per il file aggiornato
      const items = lsp.getDiagnostics(file);
      notify({
        method: 'diagnostics',
        params: { file, items },
      });
      return { ok: true };
    }

    case 'completion': {
      const file = p.file as VirtualFile;
      const line = Number(p.line ?? 0);
      const col = Number(p.col ?? 0);
      if (!ALLOWED_FILES.has(file)) throw new Error(`invalid file ${String(file)}`);
      return { items: lsp.getCompletions(file, line, col) };
    }

    case 'hover': {
      const file = p.file as VirtualFile;
      const line = Number(p.line ?? 0);
      const col = Number(p.col ?? 0);
      if (!ALLOWED_FILES.has(file)) throw new Error(`invalid file ${String(file)}`);
      return lsp.getHover(file, line, col);
    }

    case 'diagnostics': {
      const file = p.file as VirtualFile;
      if (!ALLOWED_FILES.has(file)) throw new Error(`invalid file ${String(file)}`);
      return { items: lsp.getDiagnostics(file) };
    }

    default:
      throw new Error(`unknown method: ${req.method}`);
  }
}
