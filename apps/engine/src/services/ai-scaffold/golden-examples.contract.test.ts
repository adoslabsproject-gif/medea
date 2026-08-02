/**
 * CONTRACT TEST anti-drift — ogni GOLDEN EXAMPLE è validato contro il
 * CATALOGO REALE e gli STESSI gate dello scaffold. Un esempio "gold" che
 * insegna pattern sbagliati è peggio di nessun esempio: questi test rendono
 * IMPOSSIBILE il drift silenzioso quando un NodeDef cambia (defId rinominato,
 * campo required nuovo, option select rimossa).
 *
 *   1. defId esistenti nel catalogo (un rename rompe QUI, non in produzione)
 *   2. campi REQUIRED presenti (o picker-resolvable __USE_PICKER__)
 *   3. valori dei SELECT dentro le options dichiarate dal def
 *   4. validateArchitecture: zero issue
 *   5. quality gate: zero critical (gli esempi predicano ciò che il gate esige)
 *   6. dataflow: zero fail (ogni $node.X referenzia un nodo A MONTE)
 *   7. edges riferiscono nodi esistenti, grafo connesso dal trigger
 */
import { describe, it, expect } from 'vitest';
import {
  GOLDEN_EXAMPLES,
  pickGoldenExample,
  formatGoldenExampleForPrompt,
} from './golden-examples.js';
import { buildNodeCatalog } from './node-catalog.js';
import { validateArchitecture } from './validate-architecture.js';
import { runQualityGate } from './quality-gate.js';
import { validateDataflow } from './dataflow-validator.js';
import { isPickerResolvableField } from './auto-fix.js';

const catalog = buildNodeCatalog();

describe('🚨🚨 GOLDEN EXAMPLES — contract anti-drift col catalogo reale', () => {
  for (const ex of GOLDEN_EXAMPLES) {
    describe(`gold "${ex.id}" (${ex.title})`, () => {
      const nodes = ex.workflow.nodes;
      const edges = ex.workflow.edges;

      it('tutti i defId esistono nel catalogo', () => {
        for (const n of nodes) {
          expect(
            catalog.some((c) => c.defId === n.defId),
            `defId "${n.defId}" (nodo ${n.id}) non nel catalogo`,
          ).toBe(true);
        }
      });

      it('ogni campo REQUIRED è valorizzato (o picker-resolvable) e i select usano option valide', () => {
        for (const n of nodes) {
          const entry = catalog.find((c) => c.defId === n.defId);
          expect(entry).toBeDefined();
          for (const field of entry!.fields) {
            const v = n.config[field.key];
            if (field.required) {
              const filled = v !== undefined && v !== '';
              const pickerOk =
                v === '__USE_PICKER__' && isPickerResolvableField(field.key, field.type);
              expect(filled || pickerOk, `${n.id}.${field.key} REQUIRED mancante`).toBe(true);
            }
            if (
              v !== undefined &&
              v !== '' &&
              v !== '__USE_PICKER__' &&
              field.type === 'select' &&
              field.options &&
              field.options.length > 0
            ) {
              expect(
                field.options,
                `${n.id}.${field.key}="${v}" non è tra le option [${field.options.join(',')}]`,
              ).toContain(v);
            }
          }
        }
      });

      it('edges riferiscono nodi esistenti + tutto raggiungibile dal trigger', () => {
        const ids = new Set(nodes.map((n) => n.id));
        for (const e of edges) {
          expect(ids.has(e.from), `edge.from "${e.from}" inesistente`).toBe(true);
          expect(ids.has(e.to), `edge.to "${e.to}" inesistente`).toBe(true);
        }
        // BFS dal trigger: nessun nodo orfano (un esempio con isole insegna male).
        const trigger = nodes.find((n) => n.defId.startsWith('trigger_'));
        expect(trigger, 'ogni gold parte da un trigger').toBeDefined();
        const reachable = new Set([trigger!.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const e of edges) {
            if (reachable.has(e.from) && !reachable.has(e.to)) {
              reachable.add(e.to);
              grew = true;
            }
          }
        }
        expect(
          [...ids].filter((id) => !reachable.has(id)),
          'nodi non raggiungibili dal trigger',
        ).toEqual([]);
      });

      it('validateArchitecture: zero issue', () => {
        const issues = validateArchitecture(
          nodes.map((n) => ({
            id: n.id,
            defId: n.defId,
            config: n.config as Record<string, unknown>,
          })),
          edges.map((e) => ({
            from: e.from,
            to: e.to,
            ...(e.fromPort ? { fromPort: e.fromPort } : {}),
          })),
          catalog,
        );
        expect(issues).toEqual([]);
      });

      it("quality gate: zero critical (l'esempio predica ciò che il gate esige)", () => {
        const result = runQualityGate({
          nodes: nodes.map((n) => ({
            id: n.id,
            defId: n.defId,
            config: n.config as Record<string, unknown>,
          })),
          edges: edges.map((e) => ({ from: e.from, to: e.to })),
          databases: [],
        });
        const critical = result.issues.filter((i) => i.severity === 'critical');
        expect(critical, critical.map((i) => `[${i.code}] ${i.message}`).join('\n')).toEqual([]);
      });

      it('dataflow: ogni $node.X referenzia un nodo A MONTE (zero fail)', () => {
        const fails = validateDataflow(
          nodes.map((n) => ({
            id: n.id,
            defId: n.defId,
            config: n.config as Record<string, unknown>,
          })),
          edges.map((e) => ({ from: e.from, to: e.to })),
        ).filter((i) => i.status === 'fail');
        expect(fails, fails.map((f) => `${f.nodeId}: ${f.reason}`).join('\n')).toEqual([]);
      });
    });
  }
});

describe('pickGoldenExample — selezione per goal reale', () => {
  it('goal email/triage → gold email-triage; goal form → form-to-db; goal report cron → daily-report', () => {
    expect(pickGoldenExample('smista le email in arrivo per categoria')?.id).toBe('email-triage');
    expect(pickGoldenExample('un form di contatto che salva i lead')?.id).toBe('form-to-db');
    expect(pickGoldenExample('ogni giorno alle 8 manda un report via mail')?.id).toBe(
      'daily-report',
    );
  });

  it('goal senza pattern affine → null (meglio nessun esempio che uno fuorviante)', () => {
    expect(pickGoldenExample('xyzabc qualcosa di totalmente alieno')).toBeNull();
  });

  it('formatGoldenExampleForPrompt: JSON parseable + istruzione di adattamento', () => {
    const ex = GOLDEN_EXAMPLES[0]!;
    const block = formatGoldenExampleForPrompt(ex);
    const jsonPart = /```json\n([^]*?)\n```/u.exec(block)?.[1];
    expect(jsonPart).toBeDefined();
    expect(() => JSON.parse(jsonPart!)).not.toThrow();
    expect(block).toContain('workflow NUOVO');
  });
});
