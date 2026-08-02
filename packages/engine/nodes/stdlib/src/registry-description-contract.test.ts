/**
 * Universal description contract — every NodeDef in stdlib must clear the
 * same 4-check anti-gaming bar that A3.3 stabilized for the audit-flagged
 * batch. Without this, a new node can ship with a 30-char English placeholder
 * description that bypasses palette UX, AI scaffold guidance, and SEO at
 * `/integrazioni/:id`.
 *
 * The 4 checks (kept in sync with registry.test.ts A3.3 block)
 * ─────────────────────────────────────────────────────────────
 *   1. `description.length >= 150` chars
 *   2. Does NOT start with an English imperative verb (mostly placeholder smell)
 *   3. `>= 25 distinct words` (`\p{L}\p{N}` ≥3 chars; whitespace-stuffing fails)
 *   4. Contains the literal `Use case` (case-insensitive)
 *
 * Whitelist drift detection
 * ─────────────────────────
 * `KNOWN_SUB_CONTRACT_NODES` lists defIds we KNOW don't pass yet — usually
 * legacy nodes pending a rewrite. Each entry MUST carry a reason; removing
 * a row is the "FIXED" signal. A NEW node failing the contract → CI fails
 * loud, forcing either the author to enrich the description or document
 * the gap with intent.
 *
 * Same architectural pattern as `apps/engine/src/engine/ghost-
 * coverage.test.ts`: whitelist + hard-fail on drift, breakdown report on
 * every CI run so the gap shrinks visibly over time.
 *
 * @module registry-description-contract
 */

import { describe, it, expect } from 'vitest';
import { stdlibNodes } from './registry.js';

/** Regex shared with the A3.3 block — keep alignments to avoid contract drift. */
const ENGLISH_VERB_OPENER = /^(Run|Send|Trigger|Execute|Read|Write|Get|Update|Delete|Create|Fetch|Query|Pause|Reshape|Call|Catch|Invoke|Push|Pull|Poll|Auto|Watch|Make|Build|Sleep|Wait|Receive|Calculate|Connect|Insert|Iterate|Iterates|Schedule|Subscribe|Classify|Extract|Translate|Faithful|Produce|Generate)\b/;

interface ContractViolation {
  defId: string;
  reasons: string[];
}

function checkContract(defId: string, description: string): string[] {
  const reasons: string[] = [];
  if (description.length < 150) {
    reasons.push(`length=${description.length} < 150`);
  }
  if (ENGLISH_VERB_OPENER.test(description)) {
    reasons.push(`opens with English imperative verb`);
  }
  const distinctWords = new Set(
    description.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
  if (distinctWords.size < 25) {
    reasons.push(`distinct words=${distinctWords.size} < 25 (gameable)`);
  }
  if (!/use case/i.test(description)) {
    reasons.push(`missing "Use case" enumeration`);
  }
  return reasons;
}

/**
 * Whitelist of nodes that don't yet meet the contract.
 *
 * Each entry MUST carry a one-line "why" so the rewrite owner is traceable.
 * Removing a row is the auto-promotion signal: the contract test starts
 * passing it through the regular check; the drift test catches accidental
 * re-additions.
 *
 * Initial population (2026-06-06): 71 nodes from the catalog baseline run.
 * All are pre-A3.3 nodes whose descriptions miss the "Use case:" enumerator
 * (the most common gap) or fall below the 25-distinct-words gameability
 * floor. The A3.3 stabilization sprint already rewrote 17 nodes to the
 * contract; this whitelist captures the backlog for the next enrichment
 * sprint. Order matches the test output for easy diff vs CI logs.
 */
const KNOWN_SUB_CONTRACT_NODES: ReadonlyMap<string, string> = new Map([
  // Batch enrichment 2026-06-06 — 19 nodi promossi (testo/utility/excel/pdf/
  // webhook/email/lead-gen) + Cappella Sistina rewrite di trigger_webhook,
  // action_http, trigger_imap a 9.5/10 + 12+ altri nodi (rss/stealth/browser/
  // scrape/html-select/script-var/regex/url-template/fetch-advanced/community
  // wrapper/weather/news/memory/wait/transform/wait_signal/video-metadata/
  // cloudflare/browser-render).
  // Restano per il prossimo turno: streammy_*, seo-analytics, odoo_*,
  // commercialista pipeline, email triage agents.
  // Promossi nel batch Cappella Sistina: action_web_fetch_advanced,
  // html_select, script_var_extract, regex_multi, url_template, browser_render,
  // cloudflare_solver, video_metadata, rss_feed, browser_stealth, scrape_smart.
  // SEO analytics stack (5 nodi) promosso Cappella Sistina 2026-06-06:
  // meta_extract, seo_audit, redirect_chain, link_audit, keyword_density.
  // Streammy stack (10 nodi) promosso Cappella Sistina 2026-06-06: resolve,
  // catalog, detail_page, search_multichannel, stream_proxy, catalog_page,
  // vlc_playlist, generic_extractor, iptv_m3u, domain_rotator.
  // Batch Cappella Sistina 2026-06-06: 15 nodi commercialista/odoo/email triage
  // promossi a 9.5/10 quality (≥1500-3500 char con domain-specific dettagli,
  // use case enumerati 4-5 reali, anti-pattern noti documentati, audit reason).
  // → action_odoo_rpc, action_whatsapp_send, action_pec_classify,
  //   action_email_triage, action_email_clean, flow_human_review_decision,
  //   action_pec_legal_archive, action_odoo_lookup_partner,
  //   action_odoo_create_lead, action_odoo_update_activity,
  //   agent_email_triage_commercialista, action_email_send_tracked,
  //   action_email_send_tracked_batch, agent_email_triage_b2b_sales,
  //   trigger_odoo_polling.
  // Promossi 2026-06-06: action_pdf_generate, weather_node, news_display,
  // memory_note, community_telegram, community_linear, logic_wait,
  // logic_transform, logic_wait_signal.
]);

describe('description contract — every NodeDef passes the A3.3 anti-gaming bar', () => {
  it('catalog summary (always passes; surfaces breakdown on every CI run)', () => {
    let passing = 0;
    let failingNew = 0;
    let failingKnown = 0;
    const newFailures: ContractViolation[] = [];
    const drift: string[] = [];

    for (const mod of stdlibNodes) {
      const id = mod.def.id;
      const desc = mod.def.description;
      const reasons = checkContract(id, desc);
      if (reasons.length === 0) {
        passing++;
        if (KNOWN_SUB_CONTRACT_NODES.has(id)) drift.push(id);
      } else if (KNOWN_SUB_CONTRACT_NODES.has(id)) {
        failingKnown++;
      } else {
        failingNew++;
        newFailures.push({ defId: id, reasons });
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[description-contract] catalog=${stdlibNodes.length} ` +
      `passing=${passing} knownFailing=${failingKnown} newFailing=${failingNew} ` +
      `whitelistDrift=${drift.length}`,
    );
    // 🚨 GATE 1: whitelist drift — nodi promossi a passing devono essere rimossi
    // dalla allowlist (altrimenti la allowlist diventa stale e nasconde regression).
    expect(drift, `Nodes ora passing ma ancora in KNOWN_SUB_CONTRACT_NODES (rimuovili): ${drift.join(', ')}`).toEqual([]);
    // 🚨 GATE 2: catalog non vuoto (regression detection — se import fail, 0 nodes)
    expect(stdlibNodes.length).toBeGreaterThan(50);
  });

  it('zero NEW violations — new nodes must ship with a passing description', () => {
    const offenders: ContractViolation[] = [];
    for (const mod of stdlibNodes) {
      const id = mod.def.id;
      if (KNOWN_SUB_CONTRACT_NODES.has(id)) continue;
      const desc = mod.def.description;
      const reasons = checkContract(id, desc);
      if (reasons.length > 0) offenders.push({ defId: id, reasons });
    }
    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) => `  • ${o.defId} — ${o.reasons.join(' | ')}`,
      );
      throw new Error(
        `${offenders.length} NEW description-contract violation(s) — enrich ` +
        `the NodeDef description (≥150 char IT, ≥25 distinct words, NO English ` +
        `verb opener, "Use case:" enumerated) OR add to KNOWN_SUB_CONTRACT_NODES ` +
        `with a tracked TODO ref:\n${lines.join('\n')}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  it('whitelist drift detection — a known-failing node that started passing should be removed from the whitelist', () => {
    const accidentallyFixed: string[] = [];
    for (const mod of stdlibNodes) {
      const id = mod.def.id;
      if (!KNOWN_SUB_CONTRACT_NODES.has(id)) continue;
      const desc = mod.def.description;
      const reasons = checkContract(id, desc);
      if (reasons.length === 0) accidentallyFixed.push(id);
    }
    expect(
      accidentallyFixed,
      `Whitelist drift: ${accidentallyFixed.length} node(s) now PASS the ` +
      `contract — remove from KNOWN_SUB_CONTRACT_NODES: ${accidentallyFixed.join(', ')}`,
    ).toEqual([]);
  });

  it('the 3 site-mirror trio (Sprint 2026-06-06) explicitly pass the contract', () => {
    // Anchor test: lock-in the standard for nodes added in the same sprint
    // as this contract file. Refactor of these descriptions must keep them
    // passing — no silent regression.
    for (const id of ['action_recursive_spider', 'action_asset_batch_download', 'action_html_mirror_rewrite']) {
      const mod = stdlibNodes.find((n) => n.def.id === id);
      expect(mod, `${id} must be in stdlibNodes`).toBeDefined();
      const desc = mod!.def.description;
      const reasons = checkContract(id, desc);
      expect(reasons, `${id} violates the contract: ${reasons.join(' | ')}`).toEqual([]);
    }
  });
});
