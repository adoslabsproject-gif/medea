/**
 * @medea/engine-nodes-integrations-core — REAL executors for the most-used SaaS APIs.
 *
 * 2026-05-30 — Cleanup: i 7 nodi legacy (slack_post_message, github_create_issue,
 * notion_create_page, stripe_charge, linear_create_issue, discord_webhook_post,
 * telegram_send_message) sono stati RIMOSSI dal catalogo.
 *
 * Motivazione: erano marcati `deprecated: true` con disclaimer "usa community v2.0
 * dal Marketplace", ma la v2.0 community non e\` ancora installata. Risultato:
 *  - Confusione UX: utenti vedevano "(legacy)" + warning in palette
 *  - AI scaffold (Liara) hallucinava ID v2.0 inesistenti (es. `integration_telegram_send`)
 *  - Documentation drift tra label/description e disponibilita\` reale
 *
 * Cosa fare nel frattempo per integrare Slack/Telegram/GitHub/etc.:
 *  - Usa il nodo `http_request` (stdlib) con URL della API vendor + JSON body manuale
 *  - Auth via secret: {{secrets.NOME_API_KEY}} → header Authorization configurabile
 *  - Esempio Telegram: POST https://api.telegram.org/bot{{secrets.TG_BOT}}/sendMessage
 *
 * Quando arrivera\` la v2.0:
 *  - Pubblicata come community node nel Marketplace con id `<vendor>` (no suffix)
 *  - Installazione via UI: /marketplace → cerca → install → appare in palette
 *  - Nessun rename necessario perche\` i vecchi id non esistono piu\` nel codebase
 */

import type { NodeModule } from '@medea/engine-nodes-stdlib';

/**
 * Empty array — i nodi vendor-specific sono ora delegati ai community packages
 * v2.0. Stdlib `http_request` copre il caso intermedio per integrazioni custom.
 *
 * Mantenuto come export `readonly NodeModule[]` per non rompere il contratto del
 * bundle loader (`apps/flowforge-editor/src/views/workflow-editor/layout/NodePaletteSidebar.tsx`
 * fa `coreIntegrationNodes.map((n) => n.def)` — un array vuoto produce zero nodi
 * senza crash).
 */
export const coreIntegrationNodes: readonly NodeModule[] = [] as const;
