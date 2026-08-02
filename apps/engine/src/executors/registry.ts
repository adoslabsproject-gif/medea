/**
 * Server-side executor registry.
 *
 * The browser-safe node packages (@medea/engine-nodes-stdlib, nodes-llm, etc.)
 * declare NodeDef metadata + optional executors. Some executors require Node-only
 * libraries (jsonata, nodemailer, chokidar, imapflow, isolated-vm) that can't be
 * bundled to the browser.
 *
 * This registry overlays server-side executors keyed by NodeDef id. The
 * WorkflowEngine looks here FIRST; if no override exists it falls back to the
 * executor declared in the NodeModule.
 */

import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { jsonataExecutor } from './jsonata.js';
import { sendEmailExecutor } from './nodemailer.js';
import { sendEmailTrackedExecutor } from './nodemailer-tracked.js';
import { sendEmailTrackedBatchExecutor } from './nodemailer-tracked-batch.js';
import { waitExecutor } from './wait.js';
import { paginateExecutor } from './paginate.js';
import { dbUpdateExecutor, dbDeleteExecutor } from './db-write.js';
import { ragSearchExecutor, ragIngestExecutor } from './rag.js';
import { pecArubaSendExecutor, zucchettiPayrollExecutor, sdiSendInvoiceExecutor, sdiCheckStatusExecutor } from './italian.js';
import { p7mExtractExecutor } from './sdi/p7m-extract.js';
import { fatturapaParseExecutor } from './sdi/fatturapa-parse.js';
import { pecArubaReceiveExecutor } from './pec-receive.js';
import { fileReadExecutor, fileWriteExecutor } from './file.js';
import { xlsxParseExecutor, xlsxBuildExecutor } from './excel.js';
import { textTemplateExecutor, jsonExtractExecutor, dateFormatExecutor } from './utility.js';
import { linesEnrichExecutor } from './lines-enricher.js';
import { pdfParseExecutor, pdfGenerateExecutor } from './pdf.js';
import { chartGenerateExecutor } from './chart.js';
import { tenantCollabExecutor } from './tenant-collab.js';
import { llmCompleteExecutor } from './llm-complete.js';
import { weatherExecutor } from './weather.js';
import { newsDisplayExecutor } from './news.js';
import { memoryNoteExecutor } from './memory.js';
import { webhookRespondExecutor } from './webhook-respond.js';
import { fetchUrlExecutor, webSearchExecutor } from './web-tools.js';
import { emailHarvestExecutor } from './email-harvest.js';
import { emailMxExecutor } from './email-mx.js';
import { leadScoreExecutor } from './lead-score.js';
import { emailPersonalizeExecutor } from './email-personalize.js';
import { contactDiscoveryExecutor } from './contact-discovery.js';
import { companySearchExecutor } from './company-search.js';
import { logicMergeExecutor } from './merge.js';
import { janitorCleanupExecutor } from './janitor-cleanup.js';
import { communityNodeExecutor } from './community-node.js';
import { customNodeExecutor } from './custom-node.js';
import { remoteSshDbQueryExecutor } from './remote-ssh-db-query.js';
// integrations/gmail.ts, whatsapp.ts, stripe.ts, google-drive.ts, ocr.ts
// eliminati 2026-06-06 (zombie post-cleanup ghost-coverage): non avevano
// NodeDef nel catalog runtime, l'editor li mockava soltanto. Migrazione a
// http_request (custom) + community v2.0 dal Marketplace. Decisione owner.
import { slackExecutor } from './integrations/slack.js';
import { telegramExecutor } from './integrations/telegram.js';
import { linearExecutor } from './integrations/linear.js';
import { githubExecutor } from './integrations/github.js';
import { hubspotExecutor } from './integrations/hubspot.js';
import { notionExecutor } from './integrations/notion.js';
import { salesforceExecutor } from './integrations/salesforce.js';
import { uiOpenHistoryExecutor } from './ui-open-history.js';
import { runPythonExecutor } from './run-python.js';
import { runJsExecutor } from './run-js.js';
import { runTsExecutor } from './run-ts.js';
import { securityAuditExecutor } from './security-audit.js';
import { videoSummarizerExecutor } from './video-summarizer.js';
import { legalComplianceExecutor } from './legal-compliance.js';
import { googleSheetsExecutor } from './integrations/google-sheets.js';
import { gmailExecutor } from './integrations/gmail.js';
import { discordExecutor } from './integrations/discord.js';
import { airtableExecutor } from './integrations/airtable.js';
import { trelloExecutor } from './integrations/trello.js';
import { calendlyExecutor } from './integrations/calendly.js';
import { typeformExecutor } from './integrations/typeform.js';
import { shopifyExecutor } from './integrations/shopify.js';
import { mailchimpExecutor } from './integrations/mailchimp.js';
import { twilioExecutor } from './integrations/twilio.js';
import { sendgridExecutor } from './integrations/sendgrid.js';
import { asanaExecutor } from './integrations/asana.js';
import { dropboxExecutor } from './integrations/dropbox.js';
import { boxExecutor } from './integrations/box.js';
import { gcsExecutor } from './integrations/gcs.js';
import { debugRunFailureExecutor } from './debug-run-failure.js';
import { getInstalledByDefId } from '@/services/community-nodes.service.js';

export const serverExecutors: Record<string, NodeExecutor> = {
  logic_transform: jsonataExecutor,
  action_send_email: sendEmailExecutor,
  action_email_send_tracked: sendEmailTrackedExecutor,
  action_email_send_tracked_batch: sendEmailTrackedBatchExecutor,
  logic_wait: waitExecutor,
  logic_paginate: paginateExecutor,
  db_update: dbUpdateExecutor,
  db_delete: dbDeleteExecutor,
  rag_search: ragSearchExecutor,
  rag_ingest: ragIngestExecutor,
  db_remote_ssh_query: remoteSshDbQueryExecutor,
  action_file_read: fileReadExecutor,
  action_file_write: fileWriteExecutor,
  action_xlsx_parse: xlsxParseExecutor,
  action_xlsx_build: xlsxBuildExecutor,
  action_text_template: textTemplateExecutor,
  action_json_extract: jsonExtractExecutor,
  action_date_format: dateFormatExecutor,
  action_lines_enrich: linesEnrichExecutor,
  action_pdf_parse: pdfParseExecutor,
  // 2026-06-05: 2 nodi post-audit consulente (chiusura gap defId mancanti).
  action_pdf_generate: pdfGenerateExecutor,
  action_generate_chart: chartGenerateExecutor,
  // 2026-06-12: collaborazione cross-tenant via webhook bridge HMAC-signed.
  action_tenant_collab: tenantCollabExecutor,
  action_llm_complete: llmCompleteExecutor,
  weather_node: weatherExecutor,
  news_display: newsDisplayExecutor,
  memory_note: memoryNoteExecutor,
  action_webhook_respond: webhookRespondExecutor,
  action_fetch_url: fetchUrlExecutor,
  action_web_search: webSearchExecutor,
  action_email_harvest: emailHarvestExecutor,
  action_email_validate_mx: emailMxExecutor,
  action_lead_score: leadScoreExecutor,
  action_email_personalize: emailPersonalizeExecutor,
  action_contact_discovery: contactDiscoveryExecutor,
  action_company_search: companySearchExecutor,
  logic_merge: logicMergeExecutor,
  action_janitor_cleanup: janitorCleanupExecutor,
  italia_pec_aruba_send: pecArubaSendExecutor,
  italia_pec_aruba_receive: pecArubaReceiveExecutor,
  italia_zucchetti_payroll: zucchettiPayrollExecutor,
  italia_sdi_send_invoice: sdiSendInvoiceExecutor,
  italia_sdi_check_status: sdiCheckStatusExecutor,
  // 2026-07-07 ciclo passivo INBOUND: estrazione p7m + parse FatturaPA→JSON.
  italia_p7m_extract: p7mExtractExecutor,
  italia_fatturapa_parse: fatturapaParseExecutor,
  // 2026-06-05 A3.2 P1: 3 SaaS integrations enterprise (token vault).
  integration_slack_post: slackExecutor,
  integration_telegram_send: telegramExecutor,
  integration_linear_create_issue: linearExecutor,
  // A3.2 P2+P3: 4 community node SaaS + 3 wrapper alias.
  community_github: githubExecutor,
  community_hubspot: hubspotExecutor,
  community_notion: notionExecutor,
  community_salesforce: salesforceExecutor,
  // Wrapper community: delegano agli integration_* corrispondenti.
  community_slack: slackExecutor,
  community_telegram: telegramExecutor,
  community_linear: linearExecutor,
  // UI helper (pure function).
  ui_open_history: uiOpenHistoryExecutor,
  // A4 code execution (2026-06-05): Python (code-runner Docker) + JS (isolated-vm).
  action_run_python: runPythonExecutor,
  action_run_js: runJsExecutor,
  action_run_ts: runTsExecutor,
  // A5 ghost closure (2026-06-05): 3 nodi reali post-audit consulente.
  action_security_audit: securityAuditExecutor,
  agent_video_summarizer: videoSummarizerExecutor,
  agent_legal_compliance: legalComplianceExecutor,
  // C1-C6 (2026-06-05): 6 nodi SaaS top-richiesta n8n parity.
  community_google_sheets: googleSheetsExecutor,
  action_gmail: gmailExecutor,
  community_discord: discordExecutor,
  community_airtable: airtableExecutor,
  community_trello: trelloExecutor,
  community_calendly: calendlyExecutor,
  community_typeform: typeformExecutor,
  community_shopify: shopifyExecutor,
  community_mailchimp: mailchimpExecutor,
  community_twilio: twilioExecutor,
  community_sendgrid: sendgridExecutor,
  community_asana: asanaExecutor,
  community_dropbox: dropboxExecutor,
  community_box: boxExecutor,
  community_gcs: gcsExecutor,
  // D3 AI moat (2026-06-06): debug run failures con fix + test auto-generated
  agent_debug_run_failure: debugRunFailureExecutor,
};

export function resolveServerExecutor(defId: string): NodeExecutor | undefined {
  // Static executor first (highest precedence for bundled nodes).
  // Object.hasOwn: senza, un defId come `constructor`/`toString`/`__proto__` (l'autore
  // controlla i defId del workflow) risolverebbe a una funzione del PROTOTYPE di Object
  // → type-confusion (verrebbe chiamata come NodeExecutor). Solo own-property valgono.
  const direct = Object.hasOwn(serverExecutors, defId) ? serverExecutors[defId] : undefined;
  if (direct) return direct;

  // Community node? O(1) lookup via the maintained defId→InstalledNode index.
  if (getInstalledByDefId(defId)) return communityNodeExecutor;

  // Custom Node Editor: prefisso `custom_` + il workspaceId arriva via
  // context.tenantId nel customNodeExecutor (loadCustomNodeForRun verifica
  // status runnable + compiled). Cache invalidate gestito da service.ts.
  if (defId.startsWith('custom_')) return customNodeExecutor;

  return undefined;
}
