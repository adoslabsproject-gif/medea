import { describe, it, expect } from 'vitest';
import { NodeDefSchema } from '@medea/engine-core-schema';
import { stdlibNodes, findStdlibNode, stdlibNodeDefs } from './registry.js';

describe('stdlibNodes', () => {
  it('every node module has a NodeDef that validates against the schema', () => {
    for (const node of stdlibNodes) {
      const result = NodeDefSchema.safeParse(node.def);
      if (!result.success) {
        throw new Error(`Node ${node.def.id} failed validation: ${result.error.message}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it('all node ids are unique', () => {
    const ids = stdlibNodes.map((n) => n.def.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('contains at least 12 standard nodes', () => {
    expect(stdlibNodes.length).toBeGreaterThanOrEqual(12);
  });

  it('every node has vendor "flowforge" and a semver version', () => {
    for (const node of stdlibNodes) {
      expect(node.def.vendor).toBe('flowforge');
      expect(node.def.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  // REGRESSION 2026-05-29: alcune description erano rimaste in inglese
  // (Run/Send/Pause/Reshape/...) e apparivano sulla pagina /integrazioni
  // anche con locale=it selezionato. Guard contro nuovi nodi che dimenticano
  // la traduzione. Le descrizioni stdlib sono single-source-of-truth in IT.
  it('REGRESSION: nessuna description inizia con verbo inglese hardcoded', () => {
    const englishVerbs = /^(Run|Send|Trigger|Execute|Read|Write|Get|Update|Delete|Create|Fetch|Query|Pause|Reshape|Call|Catch|Invoke|Push|Pull|Poll|Auto|Watch|Make|Build|Sleep|Wait|Receive|Calculate|Connect)\b/;
    const offenders: string[] = [];
    for (const node of stdlibNodes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
      if (englishVerbs.test(node.def.description ?? '')) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
        offenders.push(`${node.def.id}: "${node.def.description?.slice(0, 80)}"`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(`Descrizioni in inglese trovate (devono essere IT):\n${offenders.join('\n')}`);
    }
    expect(offenders).toHaveLength(0);
  });

  it('findStdlibNode locates an existing node by id', () => {
    const found = findStdlibNode('action_http');
    expect(found).toBeDefined();
    expect(found?.def.label).toBe('HTTP Request');
  });

  it('findStdlibNode returns undefined for unknown id', () => {
    expect(findStdlibNode('nonexistent_node_id')).toBeUndefined();
  });

  it('stdlibNodeDefs returns metadata only (no executors)', () => {
    const defs = stdlibNodeDefs();
    expect(defs.length).toBe(stdlibNodes.length);
    for (const def of defs) {
      expect('executor' in def).toBe(false);
    }
  });

  it('every branching node declares its outputs', () => {
    const ifNode = findStdlibNode('logic_if');
    expect(ifNode?.def.outputs).toEqual(['true', 'false']);
    const loop = findStdlibNode('logic_loop');
    expect(loop?.def.outputs).toEqual(['body', 'done']);
  });

  it('HTTP node has a runnable executor', () => {
    const http = findStdlibNode('action_http');
    expect(typeof http?.executor).toBe('function');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Streammy registration (Sprint 2026-06-04) — guard against accidental
  // de-registration. These tests verify each new node is wired with both
  // its NodeDef AND a runnable executor (no smoke: we actually call
  // `findStdlibNode` to mirror what the engine does at runtime).
  // ────────────────────────────────────────────────────────────────────────
  describe('Streammy nodes — registration', () => {
    const STREAMMY_IDS = [
      'action_streammy_resolve',
      'action_streammy_catalog',
      'action_catalog_page',
      'action_vlc_playlist',
      'action_generic_extractor',
      'action_iptv_m3u',
      'action_domain_rotator',
    ] as const;

    const STUDIO_IDS = [
      'action_odoo_rpc',
      'action_whatsapp_send',
      'action_pec_classify',
      'action_email_triage',
      'trigger_odoo_polling',
    ] as const;

    it('every studio-commercialista node id is resolvable by findStdlibNode', () => {
      for (const id of STUDIO_IDS) {
        const node = findStdlibNode(id);
        if (!node) throw new Error(`Studio node missing from registry: ${id}`);
        expect(node.def.id).toBe(id);
      }
    });

    it('every studio-commercialista node has Italian description (regression)', () => {
      const englishVerbs = /^(Run|Send|Trigger|Execute|Read|Write|Get|Update|Delete|Create|Fetch|Query|Pause|Reshape|Call|Catch|Invoke|Push|Pull|Poll|Auto|Watch|Make|Build|Sleep|Wait|Receive|Calculate|Connect)\b/;
      for (const id of STUDIO_IDS) {
        const node = findStdlibNode(id)!;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
        expect(node.def.description?.length ?? 0).toBeGreaterThan(20);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
        expect(node.def.description ?? '').not.toMatch(englishVerbs);
      }
    });

    it('pec_classify declares 4 named output branches', () => {
      const node = findStdlibNode('action_pec_classify')!;
      expect(node.def.outputs).toEqual([
        'received_message', 'acceptance_receipt', 'delivery_receipt', 'rejection',
      ]);
    });

    it('action nodes have an executor; trigger does not', () => {
      const actions = [
        'action_odoo_rpc', 'action_whatsapp_send', 'action_pec_classify', 'action_email_triage',
      ];
      for (const id of actions) {
        expect(typeof findStdlibNode(id)?.executor).toBe('function');
      }
      expect(findStdlibNode('trigger_odoo_polling')?.executor).toBeUndefined();
    });

    // ── Streammy nodi RIMOSSI dallo stdlib pubblico (2026-06-08) ──
    // I 6 streammy_* sono migrati a custom_nodes privati del tenant senza1dio
    // via Custom Node Editor (Fase 6, task #178). Test che ne verificano
    // l'ASSENZA invece della presenza (anti-regressione).
    it('streammy nodes are NOT present in public stdlib registry', () => {
      for (const id of STREAMMY_IDS) {
        expect(findStdlibNode(id)).toBeUndefined();
        const occurrences = stdlibNodes.map((n) => n.def.id).filter((x) => x === id).length;
        expect(occurrences).toBe(0);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // A3.3 stabilization contract (2026-06-05) — nodi RAW/BETA portati a STABLE.
  // Contratto: description ≥150 char, IT first sentence, branching coerente.
  // Guard contro regressioni di rewriting descrizioni accorciate.
  // ────────────────────────────────────────────────────────────────────────
  describe('A3.3 stabilized batch — enterprise description contract', () => {
    const A33_STABILIZED_IDS = [
      'logic_loop',
      'logic_delay',
      'logic_if',
      'logic_switch',
      'trigger_manual',
      'trigger_form',
      'trigger_file_watch',
      'trigger_db_change',
      'action_file_read',
      'action_file_write',
      'logic_convert',
      'logic_paginate',
      'logic_subworkflow',
      'logic_group_by',
      'logic_aggregate',
      'logic_distinct',
      'logic_window',
    ] as const;

    it('every A3.3 stabilized node has description ≥150 char + ≥25 distinct words + IT + Use case (anti-gaming)', () => {
      const englishVerbs = /^(Run|Send|Trigger|Execute|Read|Write|Get|Update|Delete|Create|Fetch|Query|Pause|Reshape|Call|Catch|Invoke|Push|Pull|Poll|Auto|Watch|Make|Build|Sleep|Wait|Receive|Calculate|Connect|Insert|Iterate|Iterates|Schedule|Subscribe|Classify|Extract|Translate|Faithful|Produce|Generate)\b/;
      const offenders: string[] = [];
      for (const id of A33_STABILIZED_IDS) {
        const node = findStdlibNode(id);
        if (!node) {
          offenders.push(`${id}: NOT FOUND in registry`);
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive guard runtime — TS narrow ottimistico
        const desc = node.def.description ?? '';
        if (desc.length < 150) {
          offenders.push(`${id}: desc length ${String(desc.length)} < 150`);
        }
        if (englishVerbs.test(desc)) {
          offenders.push(`${id}: starts with English verb "${desc.slice(0, 40)}…"`);
        }
        // Anti-gaming: distinct word count (no whitespace/ripetizione stuffing)
        const distinctWords = new Set(desc.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
        if (distinctWords.size < 25) {
          offenders.push(`${id}: only ${String(distinctWords.size)} distinct words (<25 = gameable)`);
        }
        // Mandatory enumeration delle use case (consulente flag 2026-06-05)
        if (!/use case/i.test(desc)) {
          offenders.push(`${id}: missing "Use case:" enumeration`);
        }
      }
      if (offenders.length > 0) {
        throw new Error(`A3.3 contract violations:\n${offenders.join('\n')}`);
      }
      expect(offenders).toHaveLength(0);
    });

    it('logic_loop declares strategy + branching=true + outputs body/done', () => {
      const node = findStdlibNode('logic_loop')!;
      expect(node.def.branching).toBe(true);
      expect(node.def.outputs).toEqual(['body', 'done']);
      const strategyField = node.def.configFields?.find((f) => f.key === 'strategy');
      expect(strategyField?.options).toContain('auto');
    });

    it('logic_if and logic_switch declare branching outputs', () => {
      const ifNode = findStdlibNode('logic_if')!;
      expect(ifNode.def.branching).toBe(true);
      expect(ifNode.def.outputs).toEqual(['true', 'false']);
      const switchNode = findStdlibNode('logic_switch')!;
      expect(switchNode.def.branching).toBe(true);
      expect(switchNode.def.outputs).toEqual(['*']);
    });
  });
});

// ── action_run_ts (2026-07-03): nodo TypeScript dedicato ────────────────
describe('action_run_ts — nodo Run TypeScript', () => {
  it('è registrato nel catalogo con id action_run_ts', () => {
    const node = findStdlibNode('action_run_ts');
    expect(node, 'action_run_ts deve essere nel registry stdlib').toBeDefined();
    expect(node!.def.label).toBe('Run TypeScript');
  });

  it('è cercabile per "typescript" e "ts" (searchAliases)', () => {
    const node = findStdlibNode('action_run_ts');
    const aliases = node!.def.searchAliases ?? [];
    expect(aliases).toContain('typescript');
    expect(aliases).toContain('ts');
  });

  it('espone il campo "code" di tipo code + timeout + memory', () => {
    const node = findStdlibNode('action_run_ts');
    const keys = (node!.def.configFields ?? []).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['code', 'timeoutMs', 'memoryLimitMb']));
    const codeField = (node!.def.configFields ?? []).find((f) => f.key === 'code');
    expect(codeField?.type).toBe('code');
    expect(codeField?.required).toBe(true);
  });
});

// ── action_gmail (2026-07-03): nodo Gmail dedicato (OAuth) ──────────────
describe('action_gmail — nodo Gmail dedicato', () => {
  it('è registrato con id action_gmail e label Gmail', () => {
    const node = findStdlibNode('action_gmail');
    expect(node, 'action_gmail deve essere nel registry stdlib').toBeDefined();
    expect(node!.def.label).toBe('Gmail');
  });

  it('è cercabile per "gmail" (searchAliases)', () => {
    const node = findStdlibNode('action_gmail');
    expect(node!.def.searchAliases ?? []).toContain('gmail');
  });

  it('operation è un select send/list/get e i campi send sono showIf send', () => {
    const node = findStdlibNode('action_gmail');
    const fields = node!.def.configFields ?? [];
    const op = fields.find((f) => f.key === 'operation');
    expect(op?.type).toBe('select');
    expect(op?.options).toEqual(['send', 'list', 'get']);
    const to = fields.find((f) => f.key === 'to');
    expect(to?.showIf).toMatchObject({ field: 'operation', equals: 'send' });
    const messageId = fields.find((f) => f.key === 'messageId');
    expect(messageId?.showIf).toMatchObject({ field: 'operation', equals: 'get' });
  });

  it('è DISTINTO dal nodo Email IMAP generico (id diverso, non lo sostituisce)', () => {
    const gmail = findStdlibNode('action_gmail');
    expect(gmail).toBeDefined();
    // il nodo email generico resta registrato separatamente
    const anyEmail = ['action_send_email', 'trigger_imap'].some((id) => findStdlibNode(id));
    expect(anyEmail).toBe(true);
  });
});
