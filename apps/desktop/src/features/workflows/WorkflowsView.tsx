/**
 * La sezione Workflow: elenco, editor, assistente, verdetto.
 *
 * Una regola sola governa la barra in fondo: **un workflow con problemi
 * critici non si può attivare**. È lo stesso criterio che impedisce all'AI di
 * consegnarlo, applicato a ciò che l'utente disegna a mano — sarebbe assurdo
 * che il canvas accettasse in silenzio quello che il generatore rifiuta.
 *
 * Lo stato del documento e la cronologia vivono in `useWorkflowEditor`: qui
 * si disegna e si collegano i pezzi.
 */

import { useEffect, useMemo, useState } from 'react';

import { AssistantPanel } from './assistant';
import { diagnose, globalIssues } from './canvas/diagnostics';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';
import { findNode } from './catalog';
import { ResizableColumn } from './shared';
import { Topbar } from './topbar';
import type { NodeDef } from './types';
import { useWorkflowEditor } from './useWorkflowEditor';
import { WorkflowList } from './WorkflowList';
import styles from './WorkflowsView.module.css';

/** Aperto o chiuso, la scelta resta fra una sessione e l'altra: chi lavora
 *  col pannello lo vuole trovare aperto, chi non lo usa non vuole ritrovarselo
 *  ogni volta. */
const ASSISTANT_OPEN_KEY = 'medea.workflows.assistantOpen';

export function WorkflowsView() {
  const editor = useWorkflowEditor();
  const [assistantOpen, setAssistantOpen] = useState(
    () => localStorage.getItem(ASSISTANT_OPEN_KEY) !== 'false',
  );
  const { workflow } = editor;

  useEffect(() => {
    localStorage.setItem(ASSISTANT_OPEN_KEY, String(assistantOpen));
  }, [assistantOpen]);

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
  const blockedReason =
    critical.length > 0 ? 'Non puoi attivarlo finché ci sono problemi da risolvere.' : undefined;

  // Le scorciatoie valgono su tutta la sezione, non solo sul canvas: si
  // annulla anche mentre si scrive nel pannello di destra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void editor.save();
      } else if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        editor.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [editor]);

  const activeId = workflow.id ? Number(workflow.id) : null;

  return (
    <div className={styles.root}>
      <ResizableColumn storageKey="medea.workflows.listWidth" defaultWidth={240} handle="end">
        <WorkflowList
          items={editor.items}
          activeId={activeId}
          onOpen={(id) => void editor.open(id)}
          onNew={editor.create}
          onDuplicate={(id) => void editor.duplicate(id)}
          onDelete={(id) => void editor.remove(id)}
        />
      </ResizableColumn>

      <div className={styles.main}>
        <Topbar
          workflow={workflow}
          dirty={editor.dirty}
          enabled={editor.enabled}
          assistantOpen={assistantOpen}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          canDiscard={editor.canDiscard}
          autosaving={editor.autosaving}
          {...(blockedReason ? { blockedReason } : {})}
          actions={{
            onRename: (name) => {
              editor.change({ ...workflow, name });
            },
            onSave: () => void editor.save(),
            onDiscard: editor.discard,
            onToggleEnabled: () => void editor.toggleEnabled(blockedReason),
            onToggleAssistant: () => {
              setAssistantOpen((v) => !v);
            },
            onUndo: editor.undo,
            onRedo: editor.redo,
            onAutoLayout: editor.relayout,
            onImport: editor.importJson,
            onExport: editor.exportJson,
            onDuplicate: () => {
              if (activeId) void editor.duplicate(activeId);
            },
            onDelete: () => {
              if (activeId) void editor.remove(activeId);
            },
          }}
        />

        <WorkflowCanvas workflow={workflow} onChange={editor.change} />

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

          {editor.notice && <span className={styles.notice}>{editor.notice}</span>}
        </footer>
      </div>

      {assistantOpen && (
        <ResizableColumn
          storageKey="medea.workflows.assistantWidth"
          defaultWidth={368}
          minWidth={280}
          handle="start"
        >
          <AssistantPanel
            workflow={workflow}
            onApply={(wf) => {
              editor.changeDistinct(wf);
              editor.setNotice('Modifica applicata: controllala prima di attivare il workflow.');
            }}
            onClose={() => {
              setAssistantOpen(false);
            }}
          />
        </ResizableColumn>
      )}
    </div>
  );
}
