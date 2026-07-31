/**
 * La sezione Workflow: elenco a sinistra, editor al centro, verdetto in basso.
 *
 * Una regola sola governa la barra in fondo: **un workflow con problemi
 * critici non si può attivare**. È lo stesso criterio che impedisce all'AI di
 * consegnarlo, applicato a ciò che l'utente disegna a mano — sarebbe assurdo
 * che il canvas accettasse in silenzio quello che il generatore rifiuta.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { workflowApi, type WorkflowSummary } from './api';
import { diagnose, emptyWorkflow, globalIssues } from './canvas/diagnostics';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';
import { findNode } from './catalog';
import { ScaffoldDialog } from './ScaffoldDialog';
import type { NodeDef, Workflow } from './types';
import { WorkflowList } from './WorkflowList';
import styles from './WorkflowsView.module.css';

export function WorkflowsView() {
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [workflow, setWorkflow] = useState<Workflow>(emptyWorkflow);
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [scaffolding, setScaffolding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setItems(await workflowApi.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeId = workflow.id ? Number(workflow.id) : null;

  const defsById = useMemo(() => {
    const map = new Map<string, NodeDef>();
    for (const n of workflow.nodes) {
      const def = findNode(n.defId);
      if (def) map.set(n.defId, def);
    }
    return map;
  }, [workflow.nodes]);

  const diag = useMemo(
    () => diagnose(workflow.nodes, workflow.edges, defsById),
    [workflow.nodes, workflow.edges, defsById],
  );
  const critical = diag.issues.filter((i) => i.severity === 'critical');
  const warnings = diag.issues.filter((i) => i.severity === 'medium');
  const global = globalIssues(diag.issues);

  const change = useCallback((wf: Workflow) => {
    setWorkflow(wf);
    setDirty(true);
  }, []);

  async function open(id: number) {
    const loaded = await workflowApi.get(id);
    if (!loaded) return;
    setWorkflow(loaded);
    setEnabled(items.find((i) => i.id === id)?.enabled ?? false);
    setDirty(false);
    setNotice(null);
  }

  async function save() {
    try {
      const id = await workflowApi.save(workflow, enabled);
      setWorkflow((w) => ({ ...w, id: String(id) }));
      setDirty(false);
      setNotice('Salvato.');
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleEnabled() {
    const next = !enabled;
    // Attivare un workflow rotto significa farlo fallire al primo giro:
    // meglio dirlo adesso.
    if (next && critical.length > 0) {
      setNotice('Non puoi attivarlo finché ci sono problemi da risolvere.');
      return;
    }
    setEnabled(next);
    if (activeId) {
      await workflowApi.setEnabled(activeId, next);
      await refresh();
    } else {
      setDirty(true);
    }
  }

  return (
    <div className={styles.root}>
      <WorkflowList
        items={items}
        activeId={activeId}
        onOpen={(id) => void open(id)}
        onNew={() => {
          setWorkflow(emptyWorkflow());
          setEnabled(false);
          setDirty(false);
          setNotice(null);
        }}
        onDuplicate={(id) => {
          void workflowApi.duplicate(id).then(refresh);
        }}
        onDelete={(id) => {
          void workflowApi.remove(id).then(async () => {
            if (activeId === id) setWorkflow(emptyWorkflow());
            await refresh();
          });
        }}
      />

      <div className={styles.main}>
        <header className={styles.head}>
          <input
            className={styles.name}
            value={workflow.name}
            aria-label="Nome del workflow"
            onChange={(e) => {
              change({ ...workflow, name: e.target.value });
            }}
          />

          <select
            className={styles.target}
            aria-label="Dove viene eseguito"
            value={workflow.executionTarget ?? 'local'}
            onChange={(e) => {
              change({ ...workflow, executionTarget: e.target.value as 'local' | 'server' });
            }}
          >
            <option value="local">Su questo computer</option>
            <option value="server">Sul server</option>
          </select>

          <button
            type="button"
            className={styles.ghost}
            onClick={() => {
              setScaffolding(true);
            }}
          >
            ✨ {workflow.nodes.length > 0 ? 'Modifica a parole' : 'Descrivi a parole'}
          </button>

          <button
            type="button"
            className={styles.toggle}
            data-on={enabled ? 'true' : 'false'}
            onClick={() => void toggleEnabled()}
          >
            {enabled ? 'Attivo' : 'Non attivo'}
          </button>

          <button
            type="button"
            className={styles.save}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {dirty ? 'Salva' : 'Salvato'}
          </button>
        </header>

        <WorkflowCanvas workflow={workflow} onChange={change} />

        <footer className={styles.foot} data-state={critical.length > 0 ? 'blocked' : 'ok'}>
          <div className={styles.verdict}>
            {workflow.nodes.length === 0 ? (
              <span>Workflow vuoto.</span>
            ) : critical.length > 0 ? (
              <span>
                {critical.length} {critical.length === 1 ? 'problema' : 'problemi'} da risolvere
                prima di attivarlo.
              </span>
            ) : diag.ok ? (
              <span>Tutto a posto: il workflow può essere attivato.</span>
            ) : (
              <span>Mancano dei campi obbligatori.</span>
            )}
            {warnings.length > 0 && (
              <span className={styles.warnings}>
                · {warnings.length} {warnings.length === 1 ? 'avviso' : 'avvisi'}
              </span>
            )}
          </div>

          {global.length > 0 && (
            <ul className={styles.globalIssues}>
              {global.map((i) => (
                <li key={i.code}>{i.message}</li>
              ))}
            </ul>
          )}

          {notice && <span className={styles.notice}>{notice}</span>}
        </footer>
      </div>

      {scaffolding && (
        <ScaffoldDialog
          current={workflow}
          onClose={() => {
            setScaffolding(false);
          }}
          onGenerated={(wf) => {
            change(wf);
            setScaffolding(false);
            setNotice('Workflow generato: controllalo prima di attivarlo.');
          }}
        />
      )}
    </div>
  );
}
