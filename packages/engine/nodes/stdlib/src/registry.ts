import type { NodeModule } from './types.js';
import { manualTriggerNode } from './triggers/manual.js';
import { errorTriggerNode } from './triggers/error.js';
import { cronTriggerNode } from './triggers/cron.js';
import { webhookTriggerNode } from './triggers/webhook.js';
import { whatsappTriggerNode } from './triggers/whatsapp.js';
import { telegramTriggerNode } from './triggers/telegram.js';
import { websocketTriggerNode } from './triggers/websocket.js';
import { rabbitmqTriggerNode } from './triggers/rabbitmq.js';
import { kafkaTriggerNode } from './triggers/kafka.js';
import { httpActionNode } from './actions/http.js';
import { openapiActionNode } from './actions/openapi/index.js';
import { fileReadNode, fileWriteNode } from './actions/file.js';
import { xlsxParseNode, xlsxBuildNode } from './actions/excel.js';
import { pdfParseNode, pdfGenerateNode } from './actions/pdf.js';
import { chartGenerateNode } from './actions/chart.js';
import { tenantCollabNode } from './actions/tenant-collab.js';
import { llmCompleteNode } from './actions/llm-complete.js';
import { weatherNode } from './actions/weather.js';
import { newsDisplayNode } from './actions/news.js';
import { memoryNoteNode } from './actions/memory.js';
import { uiOpenHistoryNode } from './actions/ui-open-history.js';
import { communityGithubNode } from './actions/community-github.js';
import { communityHubspotNode } from './actions/community-hubspot.js';
import { communityNotionNode } from './actions/community-notion.js';
import { communitySalesforceNode } from './actions/community-salesforce.js';
import {
  communitySlackNode,
  communityTelegramNode,
  communityLinearNode,
} from './actions/community-wrappers.js';
import { integrationSlackPostNode } from './actions/integration-slack-post.js';
import { integrationTelegramSendNode } from './actions/integration-telegram-send.js';
import { integrationLinearCreateIssueNode } from './actions/integration-linear-create-issue.js';
import { webhookRespondNode } from './actions/webhook-respond.js';
import { ifNode, switchNode } from './logic/branch.js';
import { loopNode, mergeNode, delayNode } from './logic/loop.js';
import { subworkflowNode } from './logic/subworkflow.js';
import { convertNode, waitNode, transformNode, paginateNode } from './logic/transform.js';
import { groupByNode, aggregateNode, distinctNode, windowNode } from './logic/aggregation.js';
import { waitSignalNode } from './logic/wait-signal.js';
import {
  formTriggerNode,
  fileWatchTriggerNode,
  imapTriggerNode,
  dbChangeTriggerNode,
} from './triggers/form.js';
import { emailBounceTriggerNode } from './triggers/email-bounce.js';
import { sendEmailNode } from './actions/email.js';
import { textTemplateNode, jsonExtractNode, dateFormatNode } from './actions/utility.js';
import { linesEnrichNode } from './actions/lines-enricher.js';
import { fetchUrlNode, webSearchNode } from './actions/web-tools.js';
import { cryptoNode, uuidNode, jwtNode } from './actions/crypto-utils.js';
import { csvNode, arrayNode, jsonNode } from './actions/data-transform.js';
import { textNode, templateNode } from './actions/text-utils.js';
import { datetimeNode } from './actions/datetime.js';
import { numberNode, aggregateNode as numberAggregateNode } from './actions/number-utils.js';
import { validateNode } from './actions/validate.js';
import { urlNode } from './actions/url-utils.js';
import { setFieldsNode, coalesceNode } from './actions/object-ops.js';
import { filterNode } from './actions/filter.js';
import { htmlExtractNode, markdownNode } from './actions/web-format.js';
import { diffNode } from './actions/compare.js';
import { mockDataNode } from './actions/mock.js';
import { apiResponseNode } from './actions/api-response.js';
import { emailHarvestNode } from './actions/email-harvest.js';
import { emailMxNode } from './actions/email-mx.js';
import { leadScoreNode } from './actions/lead-score.js';
import { emailPersonalizeNode } from './actions/email-personalize.js';
import { contactDiscoveryNode } from './actions/contact-discovery.js';
import { companySearchNode } from './actions/company-search.js';
import { janitorCleanupNode } from './actions/janitor-cleanup.js';
import {
  webFetchAdvancedNode,
  htmlSelectNode,
  scriptVarExtractNode,
  regexMultiNode,
  urlTemplateNode,
  browserRenderNode,
  browserAutomateNode,
  cloudflareSolverNode,
  userAgentRotateNode,
  hlsProbeNode,
  dashProbeNode,
  videoMetadataNode,
  rssFeedTriggerNode,
  sitemapCrawlerNode,
  stealthBrowserNode,
  distributedCrawlerNode,
  visionExtractNode,
  scrapeSmartNode,
  recursiveSpiderNode,
  assetBatchDownloadNode,
  htmlMirrorRewriteNode,
} from './web-extraction/index.js';
import {
  metaExtractNode,
  seoAuditNode,
  redirectChainNode,
  linkAuditNode,
  keywordDensityNode,
} from './seo-analytics/index.js';

// Streammy — i 6 nodi streammy_* + relative lib sono stati COMPLETAMENTE
// rimossi dallo stdlib pubblico (2026-06-08). Ri-importati come custom_nodes
// privati senza1dio via Custom Node Editor (Fase 6, task #178).
// NB: zero referenze residue — qualunque consumer che importava questi
// nodi deve ora installarli dal marketplace.

// Studio commercialista — Odoo + WhatsApp + PEC + Email triage + Odoo trigger
import { odooRpcActionNode } from './actions/odoo_rpc/index.js';
import { whatsAppSendActionNode } from './actions/whatsapp_send/index.js';
import { pecClassifyActionNode } from './actions/pec_classify/index.js';
import { emailTriageActionNode } from './actions/email_triage/index.js';
import { emailCleanActionNode } from './actions/email_clean/index.js';
import { humanReviewDecisionNode } from './actions/human_review_decision/index.js';
import { pecLegalArchiveActionNode } from './actions/pec_legal_archive/index.js';
import { odooLookupPartnerActionNode } from './actions/odoo_lookup_partner/index.js';
import { odooCreateLeadActionNode } from './actions/odoo_create_lead/index.js';
import { odooUpdateActivityActionNode } from './actions/odoo_update_activity/index.js';
import { emailTriageCommercialistaActionNode } from './actions/email_triage_commercialista/index.js';
import { emailSendTrackedNode } from './actions/email_send_tracked/index.js';
import { emailSendTrackedBatchNode } from './actions/email_send_tracked_batch/index.js';
import { emailTriageB2BSalesNode } from './actions/email_triage_b2b_sales/index.js';
import { odooPollingTriggerNode } from './triggers/odoo_polling/index.js';
import { runPythonNode, runJsNode } from './actions/run-code.js';
import { runTsNode } from './actions/run-ts.js';
import { gmailNode } from './actions/gmail.js';
import { securityAuditNode } from './actions/security-audit.js';
import { videoSummarizerNode } from './actions/video-summarizer.js';
import { legalComplianceNode } from './actions/legal-compliance.js';
import {
  communityGoogleSheetsNode,
  communityDiscordNode,
  communityAirtableNode,
  communityTrelloNode,
  communityCalendlyNode,
  communityTypeformNode,
  communityShopifyNode,
  communityMailchimpNode,
  communityTwilioNode,
  communitySendgridNode,
  communityAsanaNode,
  communityDropboxNode,
  communityBoxNode,
  communityGcsNode,
} from './actions/community-saas-batch.js';
import { debugRunFailureNode } from './actions/debug-run.js';

/**
 * Standard library of generic, vendor-neutral workflow nodes.
 * Provided to every FlowForge deployment out of the box.
 *
 * Add new nodes here in alphabetical order within each category.
 */
export const stdlibNodes: readonly NodeModule[] = [
  // Triggers
  manualTriggerNode,
  errorTriggerNode,
  cronTriggerNode,
  webhookTriggerNode,
  whatsappTriggerNode,
  telegramTriggerNode,
  websocketTriggerNode,
  rabbitmqTriggerNode,
  kafkaTriggerNode,
  formTriggerNode,
  emailBounceTriggerNode,
  fileWatchTriggerNode,
  imapTriggerNode,
  dbChangeTriggerNode,
  // Actions
  httpActionNode,
  openapiActionNode,
  fileReadNode,
  fileWriteNode,
  xlsxParseNode,
  xlsxBuildNode,
  pdfParseNode,
  webhookRespondNode,
  sendEmailNode,
  textTemplateNode,
  jsonExtractNode,
  dateFormatNode,
  linesEnrichNode,
  fetchUrlNode,
  webSearchNode,
  emailHarvestNode,
  emailMxNode,
  leadScoreNode,
  emailPersonalizeNode,
  contactDiscoveryNode,
  companySearchNode,
  janitorCleanupNode,
  // Web Extraction (Sprint 2026-05-31): scraping enterprise legittimo
  webFetchAdvancedNode,
  htmlSelectNode,
  scriptVarExtractNode,
  regexMultiNode,
  urlTemplateNode,
  browserRenderNode,
  browserAutomateNode,
  cloudflareSolverNode,
  userAgentRotateNode,
  hlsProbeNode,
  dashProbeNode,
  videoMetadataNode,
  rssFeedTriggerNode,
  sitemapCrawlerNode,
  // Batch 4 KILLER nodes — stealth + crawler + vision + smart-orchestrator
  stealthBrowserNode,
  distributedCrawlerNode,
  visionExtractNode,
  scrapeSmartNode,
  // Batch 6 site-mirror trio (Sprint 2026-06-06) — in-process spider +
  // parallel asset downloader + HTML offline rewriter (wget --mirror parity).
  recursiveSpiderNode,
  assetBatchDownloadNode,
  htmlMirrorRewriteNode,
  // SEO + Analytics (Sprint 2026-05-31): audit on-page, no external API key
  metaExtractNode,
  seoAuditNode,
  redirectChainNode,
  linkAuditNode,
  keywordDensityNode,
  // (6 streammy_* nodi RIMOSSI 2026-06-08 — re-importati come custom_nodes
  // privati senza1dio via Fase 6 task #178 UI Custom Node Editor)
  // Studio commercialista (Sprint 2026-06-04 v2): Odoo + WhatsApp + PEC + triage
  odooRpcActionNode,
  whatsAppSendActionNode,
  pecClassifyActionNode,
  emailTriageActionNode,
  emailCleanActionNode,
  humanReviewDecisionNode,
  pecLegalArchiveActionNode,
  odooLookupPartnerActionNode,
  odooCreateLeadActionNode,
  odooUpdateActivityActionNode,
  emailTriageCommercialistaActionNode,
  // B2B lead-gen (Sprint 2026-06-05): tracked send + batch + sales triage
  emailSendTrackedNode,
  emailSendTrackedBatchNode,
  emailTriageB2BSalesNode,
  odooPollingTriggerNode,
  // A4 code execution (2026-06-05): Python (Docker sandbox) + JS (isolated-vm)
  runPythonNode,
  runJsNode,
  runTsNode,
  gmailNode,
  // A5 ghost closure (2026-06-05): 3 nodi reali post-audit consulente
  securityAuditNode,
  videoSummarizerNode,
  legalComplianceNode,
  // C1-C6 (2026-06-05): 6 nodi SaaS top-richiesta n8n parity
  communityGoogleSheetsNode,
  communityDiscordNode,
  communityAirtableNode,
  communityTrelloNode,
  communityCalendlyNode,
  communityTypeformNode,
  communityShopifyNode,
  communityMailchimpNode,
  communityTwilioNode,
  communitySendgridNode,
  communityAsanaNode,
  communityDropboxNode,
  communityBoxNode,
  communityGcsNode,
  // D3 AI moat (2026-06-06): debug run failures con fix + test auto-generated
  debugRunFailureNode,
  // Hook-up dei 16 NodeModule preesistenti (drift sanato 2026-06-06 via ghost-coverage test):
  // erano dichiarati + executor-wired ma mai aggiunti a stdlibNodes → invisibili in
  // palette editor / AI scaffold. Vedi engine/ghost-coverage.test.ts per il pattern.
  pdfGenerateNode,
  chartGenerateNode,
  // 2026-06-12: collaborazione cross-tenant (webhook bridge HMAC-signed).
  tenantCollabNode,
  llmCompleteNode,
  weatherNode,
  newsDisplayNode,
  memoryNoteNode,
  uiOpenHistoryNode,
  communityGithubNode,
  communityHubspotNode,
  communityNotionNode,
  communitySalesforceNode,
  communitySlackNode,
  communityTelegramNode,
  communityLinearNode,
  integrationSlackPostNode,
  integrationTelegramSendNode,
  integrationLinearCreateIssueNode,
  // Logic
  ifNode,
  switchNode,
  loopNode,
  mergeNode,
  delayNode,
  subworkflowNode,
  convertNode,
  waitNode,
  transformNode,
  paginateNode,
  // Aggregation primitives (v2.0) — reduce collections before looping
  groupByNode,
  aggregateNode,
  distinctNode,
  windowNode,
  // Crypto / ID utilities (zero-deps, node:crypto)
  cryptoNode,
  uuidNode,
  jwtNode,
  // Data transformation (zero-deps, pure JS, browser-safe)
  csvNode,
  arrayNode,
  jsonNode,
  // Text / templating / datetime (zero-deps, pure JS, browser-safe)
  textNode,
  templateNode,
  datetimeNode,
  // Number / validation / URL (zero-deps, pure JS, browser-safe; checksum reali IT)
  numberNode,
  numberAggregateNode,
  validateNode,
  urlNode,
  // Object shaping / filter / web-format / compare / mock (zero-deps, pure JS, browser-safe)
  setFieldsNode,
  coalesceNode,
  filterNode,
  htmlExtractNode,
  markdownNode,
  diffNode,
  mockDataNode,
  // API builder — workflow → REST API con risposta strutturata (sentinel __webhookResponse)
  apiResponseNode,
  // Async frames (v2.0) — durable workflow suspension on external signals
  waitSignalNode,
] as const;

/**
 * Lookup a node module by its NodeDef id.
 * Returns undefined if the id is not in the standard library.
 */
export function findStdlibNode(id: string): NodeModule | undefined {
  return stdlibNodes.find((node) => node.def.id === id);
}

/**
 * Return only the NodeDef metadata (without executors).
 * Used by the editor to render the node palette.
 */
export function stdlibNodeDefs(): readonly NodeModule['def'][] {
  return stdlibNodes.map((node) => node.def);
}
