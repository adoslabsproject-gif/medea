export * from './types.js';
export * from './registry.js';

// Foundation enterprise — pattern v3.0 (middleware pipeline, Result, Zod parser).
// Consumer (engine, community-node-sdk) li importano da qui — barrel top-level.
export * from './core/index.js';
export * from './utils/index.js';
// Fase 3 (#15): logging prompt+risposta per-nodo sul canale StepLog 'llm'.
export { logLlmExchange, llmLogSinkFrom, type LlmExchange, type LlmLogSink } from './llm-exchange-log.js';
export { manualTriggerNode } from './triggers/manual.js';
export { errorTriggerNode } from './triggers/error.js';
export { cronTriggerNode } from './triggers/cron.js';
export { webhookTriggerNode } from './triggers/webhook.js';
export { whatsappTriggerNode } from './triggers/whatsapp.js';
export { telegramTriggerNode } from './triggers/telegram.js';
export { websocketTriggerNode } from './triggers/websocket.js';
export { rabbitmqTriggerNode } from './triggers/rabbitmq.js';
export { kafkaTriggerNode } from './triggers/kafka.js';
export { httpActionNode } from './actions/http.js';
export { openapiActionNode } from './actions/openapi/index.js';
export { fileReadNode, fileWriteNode } from './actions/file.js';
export { ifNode, switchNode } from './logic/branch.js';
export { loopNode, mergeNode, delayNode } from './logic/loop.js';
export { subworkflowNode } from './logic/subworkflow.js';
export { convertNode, waitNode, transformNode, paginateNode } from './logic/transform.js';
export { groupByNode, aggregateNode, distinctNode, windowNode } from './logic/aggregation.js';
export { waitSignalNode } from './logic/wait-signal.js';
export { formTriggerNode, fileWatchTriggerNode, imapTriggerNode, dbChangeTriggerNode } from './triggers/form.js';
export { emailBounceTriggerNode } from './triggers/email-bounce.js';
export { sendEmailNode } from './actions/email.js';
// Browser-safe exports for the B2B tracking suite: the NodeDef + Zod
// schema + pure types. Anything that touches `node:crypto` is in the
// server-only entry `@flowforge/nodes-stdlib/server` (see `./server.ts`).
export { emailSendTrackedNode, emailSendTrackedNodeDef, EmailSendTrackedConfigSchema, EmailSendTrackedInputSchema, type EmailSendTrackedConfig } from './actions/email_send_tracked/index.js';
export {
  emailSendTrackedBatchNode, emailSendTrackedBatchNodeDef,
  EmailSendTrackedBatchConfigSchema, EmailSendTrackedBatchInputSchema, BatchRecipientSchema,
  runBatch,
  type EmailSendTrackedBatchConfig, type BatchRecipient,
  type SchedulerOptions, type BatchItem, type BatchResult, type BatchStats, type AttemptResult,
} from './actions/email_send_tracked_batch/index.js';
export {
  emailTriageB2BSalesNode, emailTriageB2BSalesNodeDef, emailTriageB2BSalesExecutor,
  EmailTriageB2BSalesConfigSchema,
  classifyB2BSalesReply, detectLang,
  type EmailTriageB2BSalesConfig,
  type B2BSalesLabel, type Lang, type SuggestedAction,
  type ClassifyInput, type ClassifyResult,
} from './actions/email_triage_b2b_sales/index.js';
// Type-only re-exports for the HMAC token suite — runtime helpers (sign /
// verify / isBot / injectTracking) are server-only; importing them in the
// editor browser bundle would pull `node:crypto` and break Vite.
export type {
  EmailTrackingKind, EmailTrackingPayload, SignedToken,
  VerifyOptions, VerifyResult, VerifyFailReason,
} from './lib/email-tracking-token.js';
export { DEFAULT_TOKEN_TTL_SECONDS } from './lib/email-tracking-token-constants.js';
export { textTemplateNode, jsonExtractNode, dateFormatNode } from './actions/utility.js';
// 2026-06-05: 2 nodi enterprise post-audit consulente (gap REGOLA 20).
// action_pdf_generate (pdfkit, cataloghi/fatture) + action_llm_complete (Liara
// generico / BYOK). Allineano la documentazione AI scaffold ai defId reali.
export { pdfGenerateNode } from './actions/pdf.js';
export { chartGenerateNode } from './actions/chart.js';
// 2026-06-12: collaborazione cross-tenant via webhook bridge HMAC-signed (SSRF-safe, audit GDPR).
export { tenantCollabNode } from './actions/tenant-collab.js';
export { llmCompleteNode } from './actions/llm-complete.js';
// 2026-06-05 A3.2 P0: ghost node materializzati (inventory v2026-06-05).
export { weatherNode } from './actions/weather.js';
export { newsDisplayNode } from './actions/news.js';
export { memoryNoteNode } from './actions/memory.js';
// A3.2 P1: integrations SaaS esterni (token vault).
export { integrationSlackPostNode } from './actions/integration-slack-post.js';
export { integrationTelegramSendNode } from './actions/integration-telegram-send.js';
export { integrationLinearCreateIssueNode } from './actions/integration-linear-create-issue.js';
// A3.2 P2+P3: community node SaaS + wrappers + UI helper.
export { communityGithubNode } from './actions/community-github.js';
export { communityHubspotNode } from './actions/community-hubspot.js';
export { communityNotionNode } from './actions/community-notion.js';
export { communitySalesforceNode } from './actions/community-salesforce.js';
export { communitySlackNode, communityTelegramNode, communityLinearNode } from './actions/community-wrappers.js';
export { uiOpenHistoryNode } from './actions/ui-open-history.js';
export { runPythonNode, runJsNode } from './actions/run-code.js';
export { runTsNode } from './actions/run-ts.js';
export { gmailNode } from './actions/gmail.js';
export { securityAuditNode } from './actions/security-audit.js';
export { videoSummarizerNode } from './actions/video-summarizer.js';
export { legalComplianceNode } from './actions/legal-compliance.js';
export {
  communityGoogleSheetsNode, communityDiscordNode, communityAirtableNode,
  communityTrelloNode, communityCalendlyNode, communityTypeformNode,
} from './actions/community-saas-batch.js';
export { debugRunFailureNode } from './actions/debug-run.js';
export { linesEnrichNode } from './actions/lines-enricher.js';
export { fetchUrlNode, webSearchNode } from './actions/web-tools.js';
export { emailHarvestNode } from './actions/email-harvest.js';
export { emailMxNode } from './actions/email-mx.js';
export { leadScoreNode } from './actions/lead-score.js';
export { emailPersonalizeNode } from './actions/email-personalize.js';
export { contactDiscoveryNode } from './actions/contact-discovery.js';
export { companySearchNode } from './actions/company-search.js';
export { janitorCleanupNode } from './actions/janitor-cleanup.js';

// Web Extraction (Sprint 2026-05-31) — scraping enterprise legittimo + multimedia + feed
export {
  webFetchAdvancedNode,
  htmlSelectNode,
  scriptVarExtractNode,
  regexMultiNode,
  urlTemplateNode,
  browserRenderNode,
  cloudflareSolverNode,
  userAgentRotateNode,
  hlsProbeNode,
  dashProbeNode,
  videoMetadataNode,
  rssFeedTriggerNode,
  sitemapCrawlerNode,
  // Batch 4 KILLER nodes
  stealthBrowserNode,
  distributedCrawlerNode,
  visionExtractNode,
  scrapeSmartNode,
} from './web-extraction/index.js';

// SEO + Analytics (Sprint 2026-05-31) — audit on-page enterprise, no external API key
export {
  metaExtractNode,
  seoAuditNode,
  redirectChainNode,
  linkAuditNode,
  keywordDensityNode,
} from './seo-analytics/index.js';

// Streammy: tutti i nodi streammy_* + executors sono stati RIMOSSI dallo
// stdlib pubblico (2026-06-08). Tornano come custom_nodes privati senza1dio
// via Fase 6 (marketplace custom node editor).

// Studio commercialista (Sprint 2026-06-04 v2) — Odoo / WhatsApp / PEC / triage
export { odooRpcActionNode } from './actions/odoo_rpc/index.js';
export { whatsAppSendActionNode } from './actions/whatsapp_send/index.js';
export { pecClassifyActionNode } from './actions/pec_classify/index.js';
export { emailTriageActionNode } from './actions/email_triage/index.js';
export { emailCleanActionNode } from './actions/email_clean/index.js';
export { humanReviewDecisionNode } from './actions/human_review_decision/index.js';
export { pecLegalArchiveActionNode } from './actions/pec_legal_archive/index.js';
export { odooLookupPartnerActionNode } from './actions/odoo_lookup_partner/index.js';
export { odooCreateLeadActionNode } from './actions/odoo_create_lead/index.js';
export { odooUpdateActivityActionNode } from './actions/odoo_update_activity/index.js';
export { emailTriageCommercialistaActionNode } from './actions/email_triage_commercialista/index.js';
export { odooPollingTriggerNode } from './triggers/odoo_polling/index.js';
// Re-export foundation libs so consumers can use them outside node boilerplate.
export * from './lib/odoo/index.js';
export * from './lib/whatsapp/cloud-api-client.js';
export * from './lib/pec/index.js';
export * from './lib/email/triage.js';
export * from './lib/email/cleaner.js';
export * from './lib/email/triage-commercialista.js';
export * from './lib/safe-user-regex.js';
// lib/streammy — RIMOSSO (2026-06-08). Materiale moved to private-owner
// stash, sara\` ri-importato come parte dei custom_nodes privati senza1dio.

// Shared condition-rules evaluator — used by engine strategies (logic_if/switch).
export {
  parseRuleset,
  evaluateRule,
  evaluateRuleset,
  type ConditionRule,
  type ConditionRuleset,
  type Combinator,
  type RuleType,
  type EvalContext,
} from './logic/condition-rules.js';
