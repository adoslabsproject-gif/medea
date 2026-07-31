/**
 * Lo stato dell'editor: il documento aperto, la cronologia, il salvataggio.
 *
 * Sta fuori dalla vista perché la vista deve occuparsi di disegnare. Qui c'è
 * la regola che conta davvero: **ogni modifica passa da `change`**, che prima
 * registra lo stato di adesso nella cronologia. È il motivo per cui annulla
 * funziona su tutto — canvas, pannello, assistente — senza che nessuno dei tre
 * debba saperne niente.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { workflowApi, type WorkflowSummary } from './api';
import { emptyWorkflow } from './canvas/diagnostics';
import { autoLayout } from './canvas/layout';
import { exportFileName, fromImportJson, toExportJson, WorkflowImportError } from './topbar';
import { useUndoRedo } from './topbar';
import type { Workflow } from './types';
import { useAutosave } from './useAutosave';

export interface WorkflowEditor {
  workflow: Workflow;
  items: WorkflowSummary[];
  enabled: boolean;
  dirty: boolean;
  notice: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Vero quando c'è qualcosa da cui tornare indietro. */
  canDiscard: boolean;
  /** Vero mentre il salvataggio automatico sta scrivendo. */
  autosaving: boolean;
  setNotice: (text: string | null) => void;
  change: (next: Workflow) => void;
  /** Una modifica che non va fusa con la precedente nella cronologia. */
  changeDistinct: (next: Workflow) => void;
  open: (id: number) => Promise<void>;
  create: () => void;
  save: () => Promise<void>;
  toggleEnabled: (blockedReason?: string) => Promise<void>;
  duplicate: (id: number) => Promise<void>;
  remove: (id: number) => Promise<void>;
  undo: () => void;
  redo: () => void;
  /** Torna a com'era all'apertura, o all'ultimo salvataggio esplicito. */
  discard: () => void;
  relayout: () => void;
  exportJson: () => void;
  importJson: () => void;
}

export function useWorkflowEditor(): WorkflowEditor {
  const [workflow, setWorkflow] = useState<Workflow>(emptyWorkflow);
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [autosaving, setAutosaving] = useState(false);
  const history = useUndoRedo();

  /**
   * Com'era il documento all'apertura, o all'ultimo «Salva» premuto a mano.
   * È il punto a cui torna «Scarta»: con il salvataggio automatico l'ultimo
   * istante è già sul disco, quindi tornare indietro di un istante non
   * vorrebbe dire niente.
   */
  const baseline = useRef<Workflow | null>(null);

  const refresh = useCallback(async () => {
    setItems(await workflowApi.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = useCallback(
    (next: Workflow) => {
      setWorkflow((current) => {
        history.record(current);
        return next;
      });
      setDirty(true);
    },
    [history],
  );

  const changeDistinct = useCallback(
    (next: Workflow) => {
      setWorkflow((current) => {
        history.recordDistinct(current);
        return next;
      });
      setDirty(true);
    },
    [history],
  );

  const load = useCallback(
    (wf: Workflow, isEnabled: boolean) => {
      baseline.current = wf;
      setWorkflow(wf);
      setEnabled(isEnabled);
      setDirty(false);
      setNotice(null);
      // Aprire un altro workflow azzera la cronologia: annullare fin dentro
      // il documento precedente non avrebbe senso.
      history.reset();
    },
    [history],
  );

  const open = useCallback(
    async (id: number) => {
      const loaded = await workflowApi.get(id);
      if (!loaded) return;
      load(loaded, items.find((i) => i.id === id)?.enabled ?? false);
    },
    [items, load],
  );

  const create = useCallback(() => {
    load(emptyWorkflow(), false);
  }, [load]);

  /** Scrive sul disco. `manual` segna anche il nuovo punto di ritorno. */
  const persist = useCallback(
    async (manual: boolean) => {
      try {
        if (!manual) setAutosaving(true);
        const id = await workflowApi.save(workflow, enabled);
        const saved: Workflow = { ...workflow, id: String(id) };
        setWorkflow(saved);
        setDirty(false);
        if (manual) {
          baseline.current = saved;
          setNotice('Salvato.');
        }
        await refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setAutosaving(false);
      }
    },
    [workflow, enabled, refresh],
  );

  const save = useCallback(() => persist(true), [persist]);

  // Si salva da soli quando l'utente si ferma. Un documento vuoto e senza
  // nome non crea una riga solo perché la sezione è aperta.
  useAutosave({
    workflow,
    dirty,
    enabled: true,
    onSave: () => {
      void persist(false);
    },
  });

  /**
   * Scartare significa tornare al punto di partenza, e scriverlo: con il
   * salvataggio automatico quello che c'è adesso è già sul disco, quindi
   * annullarlo a metà lascerebbe due verità diverse.
   */
  const discard = useCallback(() => {
    const base = baseline.current;
    if (!base) return;
    setWorkflow(base);
    history.reset();
    if (base.id) {
      void workflowApi.save(base, enabled).then(refresh);
      setNotice('Modifiche scartate.');
      setDirty(false);
    } else {
      setDirty(true);
      setNotice('Modifiche scartate.');
    }
  }, [enabled, history, refresh]);

  const toggleEnabled = useCallback(
    async (blockedReason?: string) => {
      const next = !enabled;
      // Attivare un workflow rotto significa farlo fallire al primo giro.
      if (next && blockedReason) {
        setNotice(blockedReason);
        return;
      }
      setEnabled(next);
      if (workflow.id) {
        await workflowApi.setEnabled(Number(workflow.id), next);
        await refresh();
      } else {
        setDirty(true);
      }
    },
    [enabled, workflow.id, refresh],
  );

  const duplicate = useCallback(
    async (id: number) => {
      const newId = await workflowApi.duplicate(id);
      await refresh();
      await open(newId);
    },
    [refresh, open],
  );

  const remove = useCallback(
    async (id: number) => {
      await workflowApi.remove(id);
      if (workflow.id === String(id)) load(emptyWorkflow(), false);
      await refresh();
    },
    [workflow.id, load, refresh],
  );

  const undo = useCallback(() => {
    setWorkflow((current) => history.undo(current) ?? current);
    setDirty(true);
  }, [history]);

  const redo = useCallback(() => {
    setWorkflow((current) => history.redo(current) ?? current);
    setDirty(true);
  }, [history]);

  const relayout = useCallback(() => {
    changeDistinct({ ...workflow, nodes: autoLayout(workflow.nodes, workflow.edges) });
  }, [workflow, changeDistinct]);

  const exportJson = useCallback(() => {
    const blob = new Blob([toExportJson(workflow)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(workflow);
    a.click();
    URL.revokeObjectURL(url);
  }, [workflow]);

  const importJson = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        try {
          const imported = fromImportJson(text);
          load(imported, false);
          setDirty(true);
          setNotice(`Importato: ${String(imported.nodes.length)} nodi.`);
        } catch (e) {
          setNotice(e instanceof WorkflowImportError ? e.message : String(e));
        }
      });
    };
    input.click();
  }, [load]);

  return {
    workflow,
    items,
    enabled,
    dirty,
    notice,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    canDiscard: baseline.current !== null && dirty,
    autosaving,
    setNotice,
    change,
    changeDistinct,
    open,
    create,
    save,
    toggleEnabled,
    duplicate,
    remove,
    undo,
    redo,
    discard,
    relayout,
    exportJson,
    importJson,
  };
}
