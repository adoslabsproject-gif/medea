/**
 * La conversazione: cosa succede quando l'utente scrive.
 *
 * Ogni messaggio fa girare l'agente sul workflow **corrente**, quindi la
 * seconda richiesta parte da dove ha lasciato la prima: «aggiungi un
 * controllo» funziona perché l'agente vede quello che ha già costruito.
 *
 * Niente viene applicato da solo. L'agente produce un workflow, qui se ne
 * calcola il diff, e il canvas cambia solo quando l'utente lo accetta.
 */

import { useCallback, useRef, useState } from 'react';

import { autoLayout, needsLayout } from '../canvas/layout';
import { allNodes } from '../catalog';
import { createAgentChat, runWorkflowAgent, type AgentStep } from '../scaffold';
import type { Workflow } from '../types';

import { computePatch } from './diff';
import { isEmptyPatch, type ChatMessage } from './types';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `m${String(counter)}`;
}

interface Options {
  /** Il workflow su cui l'assistente lavora, sempre aggiornato. */
  workflow: Workflow;
}

export interface WorkflowChat {
  messages: ChatMessage[];
  busy: boolean;
  /** I passi dell'agente nel giro in corso, per mostrarli mentre lavora. */
  liveSteps: AgentStep[];
  send: (text: string) => Promise<void>;
  applyPatch: (messageId: string) => Workflow | null;
  dismissPatch: (messageId: string) => void;
  clear: () => void;
}

export function useWorkflowChat({ workflow }: Options): WorkflowChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);

  // Il workflow cambia mentre l'agente lavora (l'utente può spostare un nodo):
  // serve il valore al momento dell'invio, non quello catturato alla creazione
  // della funzione.
  const latest = useRef(workflow);
  latest.current = workflow;

  const send = useCallback(async (text: string) => {
    const goal = text.trim();
    if (!goal) return;

    const base = latest.current;
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: goal, at: Date.now() }]);
    setBusy(true);
    setLiveSteps([]);

    const reply = (patch: Partial<ChatMessage>) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text: '', at: Date.now(), ...patch },
      ]);
    };

    try {
      const chat = await createAgentChat();
      const result = await runWorkflowAgent({
        goal,
        catalog: [...allNodes()],
        chat,
        ...(base.nodes.length > 0 ? { seed: base } : {}),
        onStep: (step) => {
          setLiveSteps((prev) => [...prev, step]);
        },
      });

      if (!result.ok) {
        reply({ text: 'Non sono riuscito a completare la modifica.', error: result.reason });
        return;
      }

      // Un workflow generato da zero arriva senza coordinate sensate: il
      // disegno lo facciamo noi. Uno modificato conserva le sue.
      const produced: Workflow = {
        ...result.workflow,
        ...(base.id ? { id: base.id } : {}),
        nodes: needsLayout(result.workflow.nodes)
          ? autoLayout(result.workflow.nodes, result.workflow.edges)
          : result.workflow.nodes,
      };

      const patch = computePatch(base, produced);
      if (isEmptyPatch(patch)) {
        reply({
          text: 'Il workflow è già come chiedi: non ho trovato niente da cambiare.',
          steps: result.steps,
        });
        return;
      }

      reply({
        text:
          result.remainingIssues.length > 0
            ? `Ecco la modifica. Restano da sistemare: ${result.remainingIssues.join(' ')}`
            : 'Ecco la modifica proposta.',
        steps: result.steps,
        patch,
      });
    } catch (e) {
      reply({
        text: 'Non sono riuscito a parlare con il modello.',
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
      setLiveSteps([]);
    }
  }, []);

  const applyPatch = useCallback((messageId: string): Workflow | null => {
    let applied: Workflow | null = null;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId || !m.patch) return m;
        applied = m.patch.next;
        return { ...m, applied: true };
      }),
    );
    return applied;
  }, []);

  const dismissPatch = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const { patch: _discarded, ...rest } = m;
        return rest;
      }),
    );
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, busy, liveSteps, send, applyPatch, dismissPatch, clear };
}
