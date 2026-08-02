/**
 * Ghost coverage — runtime dispatch reachability for every registered defId.
 *
 * What this test enforces
 * ───────────────────────
 * A `defId` is a "ghost" when it is registered in the runtime's canonical
 * catalog (`ALL_NODE_MODULES`) but no execution path can reach it. A ghost
 * silently fails at run-time with `Unknown node def` AFTER the editor has
 * happily let the user place it on a canvas — the worst possible UX.
 *
 * The runtime resolves `defId → execution` via five mutually-exclusive paths
 * (see `engine/strategies/index.ts` + `node-executor.strategy.ts`):
 *
 *   1. Engine strategy             — `logic_if` / `logic_switch` / `logic_delay`
 *                                     are dispatched without an executor at all
 *                                     (the strategy IS the implementation).
 *   2. Engine native handler       — `logic_loop` is dispatched to the
 *                                     `IterationCoordinator` (workflow-engine.ts:597);
 *                                     `logic_wait_signal` is suspended via the
 *                                     paused-workflows service (workflow-engine.ts:586).
 *                                     Both have NO executor by design.
 *   3. Trigger passthrough          — anything with `def.type === 'trigger'` OR
 *                                     `defId.startsWith('trigger_')` is yielded
 *                                     straight to the workflow entry hook.
 *   4. Server-side override         — `serverExecutors[defId]` in
 *                                     `executors/registry.ts`, takes precedence
 *                                     over the bundled module executor (Node-only
 *                                     libs like jsonata, isolated-vm, …). The
 *                                     community dispatch also runs through here
 *                                     via `getInstalledByDefId`.
 *   5. Bundled module executor      — `module.executor` declared inline in the
 *                                     browser-safe package. Fallback for nodes
 *                                     that don't need Node-only libs.
 *
 * A defId is a ghost when NONE of (1..5) match.
 *
 * Why an integration test (not a static script)
 * ─────────────────────────────────────────────
 * Vitest runs this on every push/PR via the standard suite — CI gates merges
 * the moment somebody adds a NodeDef without wiring its executor. The previous
 * "manual scan dichiarata 150/150 zero ghost" was a snapshot in time; this is
 * a continuous proof.
 *
 * Known issues (whitelisted with rationale)
 * ─────────────────────────────────────────
 * The runtime has TWO categories of pre-existing debt this test surfaces but
 * does not auto-fail on (a hard fail here would block CI for unrelated work):
 *
 *   • `logic_error_handler` — declared in `nodes/stdlib/src/logic/loop.ts:233`
 *     and documented in editor + AI scaffold prompts, BUT no engine dispatch
 *     exists. Workflows using it crash with `Unknown node def`. Owner: engine
 *     team. Resolution: either implement the wrap-error-catching strategy or
 *     remove the NodeModule + update AI prompts (`services/ai-scaffold/prompts.ts:222`).
 *
 *   • Server-side ORPHAN executors — `serverExecutors` keys for defIds with
 *     no corresponding NodeModule in `ALL_NODE_MODULES`. Two sub-cases:
 *       (a) `integration_gmail/whatsapp/stripe/google_drive/ocr` — defIds
 *           present in `apps/portal/src/data/node-catalog.en.ts:364-380` and
 *           `node-defs.generated.json`, but NO NodeModule in the workspace
 *           packages. Editor shows them; runtime executes them; engine
 *           catalog-resolution misses them (workflow-engine.ts:318 returns
 *           undefined). Owner: integration team — needs NodeModule wrappers.
 *       (b) `action_pdf_generate/action_llm_complete/weather_node/news_display/
 *           memory_note/ui_open_history` + `community_github/hubspot/notion/
 *           salesforce` + `community_slack/telegram/linear` + `integration_
 *           slack_post/telegram_send/linear_create_issue` — these DO have a
 *           NodeModule exported from `nodes/stdlib/src/actions/*.ts` but were
 *           never added to the `stdlibNodes` array in `registry.ts`. Simple
 *           registration fix. Owner: stdlib maintainer.
 *
 * Both categories are listed by id below. A separate test asserts they don't
 * GROW silently — any new orphan would fail the count check, forcing
 * intentional triage.
 *
 * @module engine/ghost-coverage
 */

import { describe, it, expect } from 'vitest';
import { ALL_NODE_MODULES } from './workflow-engine.js';
import { resolveServerExecutor, serverExecutors } from '../executors/registry.js';
import type { NodeModule } from '@medea/engine-nodes-stdlib';

/**
 * DefIds the engine handles without an executor — strategies in
 * `engine/strategies/{logic-if,logic-switch,logic-delay}.strategy.ts`.
 */
const ENGINE_STRATEGY_DEF_IDS: ReadonlySet<string> = new Set([
  'logic_if',
  'logic_switch',
  'logic_delay',
]);

/**
 * DefIds dispatched by the engine via direct match BEFORE the strategy chain
 * runs (see `workflow-engine.ts`). They have no executor by design.
 *
 *   workflow-engine.ts:586  → `if (module.def.id === 'logic_wait_signal')`
 *                              → pausedWorkflowsService.pause(...)
 *   workflow-engine.ts:597  → `if (module.def.id === 'logic_loop')`
 *                              → iterationCoordinator.execute(...)
 */
const ENGINE_NATIVE_DEF_IDS: ReadonlySet<string> = new Set([
  'logic_loop',
  'logic_wait_signal',
]);

/**
 * KNOWN ghosts — defIds in the catalog with NO reachable execution path.
 * Whitelisted to keep CI green while the underlying bug is tracked elsewhere.
 * Removing an entry is the "FIXED" signal: the test will silently start
 * passing it through the regular reachability check.
 *
 * Each entry MUST carry a referenced TODO (file:line) so the bug owner is
 * traceable. The reporter sub-test below also prints them on every run.
 *
 * Cleaned 2026-06-06: `logic_error_handler` removed from stdlibNodes entirely
 * (was declared + advertised by AI scaffold but never implemented). See
 * `packages/engine/nodes/stdlib/src/logic/loop.ts:232` history comment.
 */
const KNOWN_GHOST_PENDING_IMPL: ReadonlyMap<string, string> = new Map([]);

/**
 * KNOWN orphan `serverExecutors` entries — keys with no matching defId in
 * `ALL_NODE_MODULES`. Should always be empty in steady state.
 *
 * Cleaned 2026-06-06: all 21 prior orphans resolved in one sweep:
 *   - 5 zombie `integration_gmail/whatsapp/stripe/google_drive/ocr` removed
 *     (no NodeModule, executor files deleted, catalog UI mocks purged).
 *   - 16 NodeModule-but-unregistered nodes (pdfGenerate, llmComplete, weather,
 *     news, memory, ui_open_history, community_{github,hubspot,notion,
 *     salesforce}, community_{slack,telegram,linear}, integration_{slack_post,
 *     telegram_send,linear_create_issue}) added to `stdlibNodes` array.
 *
 * Going forward, any NEW orphan should be wired immediately. If genuinely
 * blocked, document here with a tracking link before merging.
 */
const KNOWN_ORPHAN_SERVER_EXECUTORS: ReadonlyMap<string, string> = new Map([]);

type DispatchLane =
  | 'engine-strategy'
  | 'engine-native'
  | 'trigger'
  | 'server-override'
  | 'module-bundled'
  | 'KNOWN-GHOST'
  | 'GHOST';

interface DispatchResult {
  reachable: boolean;
  lane: DispatchLane;
  /** Human-readable failure reason when `reachable=false`. */
  reason?: string;
}

function classify(mod: NodeModule): DispatchResult {
  const id = mod.def.id;

  if (ENGINE_STRATEGY_DEF_IDS.has(id)) {
    return { reachable: true, lane: 'engine-strategy' };
  }
  if (ENGINE_NATIVE_DEF_IDS.has(id)) {
    return { reachable: true, lane: 'engine-native' };
  }
  if (mod.def.type === 'trigger' || id.startsWith('trigger_')) {
    return { reachable: true, lane: 'trigger' };
  }
  if (resolveServerExecutor(id)) {
    return { reachable: true, lane: 'server-override' };
  }
  if (typeof mod.executor === 'function') {
    return { reachable: true, lane: 'module-bundled' };
  }
  if (KNOWN_GHOST_PENDING_IMPL.has(id)) {
    return {
      reachable: false,
      lane: 'KNOWN-GHOST',
      reason: KNOWN_GHOST_PENDING_IMPL.get(id)!,
    };
  }
  return {
    reachable: false,
    lane: 'GHOST',
    reason:
      `type=${mod.def.type} | ` +
      `engine=no | trigger=no | serverExec=missing | moduleExec=${typeof mod.executor}`,
  };
}

describe('ghost-coverage — runtime dispatch reachability', () => {
  it('zero NEW ghosts: every catalog entry resolves to a dispatch lane (excluding known issues)', () => {
    const ghosts: { id: string; reason: string }[] = [];

    for (const mod of ALL_NODE_MODULES) {
      const r = classify(mod);
      // KNOWN-GHOST is allowed — it's a tracked issue with an owner. GHOST is
      // a NEW reachability hole and MUST fail CI.
      if (r.lane === 'GHOST') {
        ghosts.push({ id: mod.def.id, reason: r.reason ?? 'unknown' });
      }
    }

    const message =
      ghosts.length === 0
        ? ''
        : `Found ${ghosts.length} NEW ghost(s) — catalog entries with no reachable execution path:\n` +
          ghosts.map((g) => `  • ${g.id}  — ${g.reason}`).join('\n') +
          `\n\nWire them via one of: serverExecutors[id]=…, module.executor=…, ` +
          `engine strategy, or trigger flag. If it's a tracked TODO, add to ` +
          `KNOWN_GHOST_PENDING_IMPL with a file:line reference.`;

    expect(ghosts, message).toEqual([]);
  });

  it('whitelisted issues still match reality (alarm if a known ghost gets FIXED — promote it)', () => {
    // If a KNOWN_GHOST_PENDING_IMPL entry is silently fixed (engine team
    // implements `logic_error_handler`, say), the whitelist entry becomes
    // dead weight. This test catches that case — remove the entry.
    const stillGhosts: string[] = [];
    const accidentallyFixed: string[] = [];

    for (const mod of ALL_NODE_MODULES) {
      const id = mod.def.id;
      if (!KNOWN_GHOST_PENDING_IMPL.has(id)) continue;
      const r = classify(mod);
      // KNOWN-GHOST lane means: it would BE a ghost if not whitelisted →
      // still broken, expected. Anything else means it's been fixed.
      if (r.lane === 'KNOWN-GHOST') {
        stillGhosts.push(id);
      } else {
        accidentallyFixed.push(`${id} (now resolves via ${r.lane})`);
      }
    }

    expect(
      accidentallyFixed,
      `Whitelist drift: these defIds are NO LONGER ghosts — please remove them ` +
        `from KNOWN_GHOST_PENDING_IMPL: ${accidentallyFixed.join(', ')}`,
    ).toEqual([]);

    expect(stillGhosts.sort()).toEqual([...KNOWN_GHOST_PENDING_IMPL.keys()].sort());
  });

  it('breakdown report — every defId is dispatched through exactly one lane (KNOWN-GHOST tolerated)', () => {
    const counts: Record<DispatchLane, number> = {
      'engine-strategy': 0,
      'engine-native': 0,
      trigger: 0,
      'server-override': 0,
      'module-bundled': 0,
      'KNOWN-GHOST': 0,
      GHOST: 0,
    };

    for (const mod of ALL_NODE_MODULES) {
      counts[classify(mod).lane]++;
    }

    const total = ALL_NODE_MODULES.length;
    const reachable =
      counts['engine-strategy'] + counts['engine-native'] + counts.trigger +
      counts['server-override'] + counts['module-bundled'];

     
    console.log(
      `[ghost-coverage] total=${total} ` +
      `engineStrategy=${counts['engine-strategy']} engineNative=${counts['engine-native']} ` +
      `trigger=${counts.trigger} serverOverride=${counts['server-override']} ` +
      `moduleBundled=${counts['module-bundled']} ` +
      `knownGhost=${counts['KNOWN-GHOST']} newGhost=${counts.GHOST}`,
    );

    expect(reachable + counts['KNOWN-GHOST'] + counts.GHOST).toBe(total);
    expect(counts.GHOST).toBe(0); // hard: zero NEW ghosts
  });

  it('orphan serverExecutors keys match the documented whitelist (no NEW orphans)', () => {
    // Drift detection: if somebody ADDs a serverExecutor for a defId that
    // doesn't yet have a NodeModule, this test fails — forcing them to
    // either author the NodeModule OR document the orphan in the whitelist.
    const catalog = new Set(ALL_NODE_MODULES.map((m) => m.def.id));
    const orphans = Object.keys(serverExecutors).filter((id) => !catalog.has(id));
    const knownOrphans = new Set(KNOWN_ORPHAN_SERVER_EXECUTORS.keys());

    const newOrphans = orphans.filter((id) => !knownOrphans.has(id));
    const accidentallyFixed = [...knownOrphans].filter((id) => !orphans.includes(id));

    const messages: string[] = [];
    if (newOrphans.length > 0) {
      messages.push(
        `${newOrphans.length} NEW orphan serverExecutors key(s) — wire a NodeModule ` +
          `or whitelist with TODO ref:\n` +
          newOrphans.map((id) => `  • ${id}`).join('\n'),
      );
    }
    if (accidentallyFixed.length > 0) {
      messages.push(
        `${accidentallyFixed.length} whitelist drift — remove from ` +
          `KNOWN_ORPHAN_SERVER_EXECUTORS (defId now registered): ` +
          accidentallyFixed.join(', '),
      );
    }

    expect(messages, messages.join('\n\n')).toEqual([]);
  });

  it('no duplicate defIds across registered packages', () => {
    const seen = new Map<string, number>();
    for (const mod of ALL_NODE_MODULES) {
      seen.set(mod.def.id, (seen.get(mod.def.id) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);

    expect(duplicates, `Duplicate defIds in ALL_NODE_MODULES: ${duplicates.join(', ')}`).toEqual([]);
  });

  it('TODO inventory — visible heartbeat + cap MAX 50 ghost+orphan (regression gate)', () => {
    // 🚨 GATE: la lista "known TODO" non deve crescere indiscriminata. 50 è
    // la soglia oltre cui significherebbe che il team accumula debt senza
    // fixare. Bug = nuovi nodi rotti aggiunti alla allowlist senza fix.
    const total = KNOWN_GHOST_PENDING_IMPL.size + KNOWN_ORPHAN_SERVER_EXECUTORS.size;
    if (total === 0) {
       
      console.log('[ghost-coverage] TODO inventory: clean. Zero known issues.');
    } else {
       
      console.log(
        `[ghost-coverage] TODO inventory — ${KNOWN_GHOST_PENDING_IMPL.size} ghost(s) + ` +
        `${KNOWN_ORPHAN_SERVER_EXECUTORS.size} orphan(s) pending:`,
      );
      for (const [id, why] of KNOWN_GHOST_PENDING_IMPL) {
         
        console.log(`  GHOST: ${id} — ${why}`);
      }
      for (const [id, why] of KNOWN_ORPHAN_SERVER_EXECUTORS) {
         
        console.log(`  ORPHAN: ${id} — ${why}`);
      }
    }
    // Hard cap: oltre 50 known-TODO = anti-pattern, refactor obbligatorio
    expect(total, `Known TODO inventory exceeded soft cap of 50 (${total} entries)`).toBeLessThan(50);
  });
});
