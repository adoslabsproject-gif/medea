/**
 * Cosa ha prodotto ogni nodo l'ultima volta che il workflow è girato.
 *
 * Serve ai suggerimenti di espressione: i campi dichiarati dal catalogo dicono
 * cosa un nodo produce *in generale*, questi dicono cosa ha prodotto **qui**.
 * Un `action_http` dichiara `body`; cosa c'è dentro quel body lo si sa solo
 * dopo averlo chiamato una volta.
 *
 * Se non è mai stato eseguito la mappa è vuota, e i suggerimenti tornano a
 * quelli dichiarati: non è un errore, è il primo giro.
 */

import { useEffect, useState } from 'react';

import { runsApi } from './api';
import type { RunStep } from './types';

/** Quello che un passo ha prodotto, riportato a valore. */
function parse(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function useLastRunOutputs(workflowId: number | null): ReadonlyMap<string, unknown> {
  const [outputs, setOutputs] = useState<ReadonlyMap<string, unknown>>(new Map());

  useEffect(() => {
    if (workflowId === null) {
      setOutputs(new Map());
      return;
    }

    let vivo = true;
    void (async () => {
      try {
        const runs = await runsApi.list(workflowId, 1);
        const ultima = runs[0];
        if (!ultima) {
          if (vivo) setOutputs(new Map());
          return;
        }

        const record = await runsApi.get(ultima.id);
        const steps: RunStep[] = record?.stepsJson
          ? (JSON.parse(record.stepsJson) as RunStep[])
          : [];

        const mappa = new Map<string, unknown>();
        for (const step of steps) {
          const valore = parse(step.output);
          if (valore !== undefined) mappa.set(step.nodeId, valore);
        }
        if (vivo) setOutputs(mappa);
      } catch {
        // Lo storico non è indispensabile: senza, i suggerimenti restano
        // quelli dichiarati dal catalogo.
        if (vivo) setOutputs(new Map());
      }
    })();

    return () => {
      vivo = false;
    };
  }, [workflowId]);

  return outputs;
}
