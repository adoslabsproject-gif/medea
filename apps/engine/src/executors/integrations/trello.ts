/**
 * Trello executor — REST v1 (API key + OAuth1 token query params in vault).
 */
import { coerceString } from '@/lib/coerce.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { IntegrationError, requireIntegration, withRetry } from './common.js';
import { jsonFetch, getIntegrationLabel } from './saas-shared.js';

export const trelloExecutor: NodeExecutor = async (rawConfig, _input, context) => {
  const start = Date.now();
  const cfg = rawConfig;
  const operation = coerceString(cfg.operation ?? 'createCard');

  const integ = requireIntegration({
    provider: 'trello',
    tenantId: context.tenantId,
    label: getIntegrationLabel(cfg),
  });
  const { apiKey, oauthToken } = integ.credentials as { apiKey?: string; oauthToken?: string };
  if (!apiKey || !oauthToken) {
    throw new IntegrationError({
      provider: 'trello',
      code: 'INVALID_CREDENTIALS',
      message: 'apiKey + oauthToken obbligatori',
    });
  }
  const auth = `key=${apiKey}&token=${oauthToken}`;

  let card: unknown = null;
  let cards: unknown[] = [];
  let lists: unknown[] = [];
  await withRetry(
    async () => {
      switch (operation) {
        case 'createCard': {
          const listId = coerceString(cfg.listId ?? '').trim();
          if (!listId)
            throw new IntegrationError({
              provider: 'trello',
              code: 'INVALID_PAYLOAD',
              message: 'listId obbligatorio',
            });
          const params = new URLSearchParams();
          params.set('idList', listId);
          if (cfg.name) params.set('name', coerceString(cfg.name));
          if (cfg.desc) params.set('desc', coerceString(cfg.desc));
          if (cfg.due) params.set('due', coerceString(cfg.due));
          card = await jsonFetch(
            'trello',
            `https://api.trello.com/1/cards?${params.toString()}&${auth}`,
            null,
            { method: 'POST' },
          );
          break;
        }
        case 'updateCard': {
          const id = coerceString(cfg.cardId ?? '').trim();
          if (!id)
            throw new IntegrationError({
              provider: 'trello',
              code: 'INVALID_PAYLOAD',
              message: 'cardId obbligatorio',
            });
          const params = new URLSearchParams();
          for (const k of ['name', 'desc', 'due'] as const)
            if (cfg[k]) params.set(k, coerceString(cfg[k]));
          card = await jsonFetch(
            'trello',
            `https://api.trello.com/1/cards/${encodeURIComponent(id)}?${params.toString()}&${auth}`,
            null,
            { method: 'PUT' },
          );
          break;
        }
        case 'addComment': {
          const id = coerceString(cfg.cardId ?? '').trim();
          const text = coerceString(cfg.commentText ?? '').trim();
          if (!id || !text)
            throw new IntegrationError({
              provider: 'trello',
              code: 'INVALID_PAYLOAD',
              message: 'cardId + commentText obbligatori',
            });
          card = await jsonFetch(
            'trello',
            `https://api.trello.com/1/cards/${encodeURIComponent(id)}/actions/comments?text=${encodeURIComponent(text)}&${auth}`,
            null,
            { method: 'POST' },
          );
          break;
        }
        case 'listCards': {
          const boardId = coerceString(cfg.boardId ?? '').trim();
          const listId = coerceString(cfg.listId ?? '').trim();
          if (!boardId && !listId)
            throw new IntegrationError({
              provider: 'trello',
              code: 'INVALID_PAYLOAD',
              message: 'boardId o listId obbligatorio',
            });
          const path = boardId
            ? `boards/${encodeURIComponent(boardId)}/cards`
            : `lists/${encodeURIComponent(listId)}/cards`;
          cards = await jsonFetch<unknown[]>(
            'trello',
            `https://api.trello.com/1/${path}?${auth}`,
            null,
          );
          break;
        }
        case 'getBoardLists': {
          const boardId = coerceString(cfg.boardId ?? '').trim();
          if (!boardId)
            throw new IntegrationError({
              provider: 'trello',
              code: 'INVALID_PAYLOAD',
              message: 'boardId obbligatorio',
            });
          lists = await jsonFetch<unknown[]>(
            'trello',
            `https://api.trello.com/1/boards/${encodeURIComponent(boardId)}/lists?${auth}`,
            null,
          );
          break;
        }
        default:
          throw new IntegrationError({
            provider: 'trello',
            code: 'INVALID_PAYLOAD',
            message: `operation "${operation}" non supportata`,
          });
      }
    },
    { label: `trello.${operation}` },
  );

  return {
    output: { ok: true, card, cards, lists, count: cards.length },
    durationMs: Date.now() - start,
  };
};
