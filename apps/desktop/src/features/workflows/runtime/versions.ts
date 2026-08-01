/**
 * Le versioni di un workflow.
 *
 * Un workflow che funzionava e adesso non funziona più è la situazione in cui
 * si perde più tempo, e l'unica domanda che conta è «com'era prima?». Senza
 * versioni la risposta è: non si sa.
 *
 * Le tiene il runtime, che le scrive da solo a ogni aggiornamento del
 * documento. Qui si aggiunge il punto fermo esplicito — quello che l'utente
 * mette prima di cambiare qualcosa di grosso — e il ritorno indietro.
 */

import { runtimeApi } from './client';

export interface WorkflowVersion {
  id: string;
  versionNumber: number;
  createdAt: string;
  createdBy: string | null;
  /** Perché è stata presa. `auto` quando l'ha presa il runtime da solo. */
  comment: string | null;
}

interface VersionDocument {
  name?: string;
  description?: string;
  nodes?: unknown[];
  edges?: unknown[];
}

/** Le versioni, dalla più recente. */
export async function listVersions(runtimeWorkflowId: string): Promise<WorkflowVersion[]> {
  const { versions } = await runtimeApi.get<{ versions: WorkflowVersion[] }>(
    `/workflows/${runtimeWorkflowId}/versions`,
  );
  return versions;
}

/** Mette un punto fermo, con il motivo scritto sopra. */
export async function snapshotVersion(
  runtimeWorkflowId: string,
  comment: string,
): Promise<{ versionId: string; versionNumber: number }> {
  const query = comment ? `?comment=${encodeURIComponent(comment)}` : '';
  return runtimeApi.post(`/workflows/${runtimeWorkflowId}/versions${query}`, {});
}

/** Il documento di quella versione, per guardarlo senza ripristinarlo. */
export async function getVersion(
  runtimeWorkflowId: string,
  versionId: string,
): Promise<VersionDocument> {
  const { workflow } = await runtimeApi.get<{ workflow: VersionDocument }>(
    `/workflows/${runtimeWorkflowId}/versions/${versionId}`,
  );
  return workflow;
}

/**
 * Torna a una versione.
 *
 * Il runtime prende prima un'istantanea di com'è adesso: tornare indietro non
 * deve poter perdere quello da cui si torna.
 */
export async function rollbackVersion(
  runtimeWorkflowId: string,
  versionId: string,
): Promise<VersionDocument> {
  const { workflow } = await runtimeApi.post<{ workflow: VersionDocument }>(
    `/workflows/${runtimeWorkflowId}/versions/${versionId}/rollback`,
    {},
  );
  return workflow;
}
