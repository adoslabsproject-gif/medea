/**
 * I form pubblici, e cosa ci è arrivato dentro.
 *
 * Un workflow che comincia con `trigger_form` espone una pagina compilabile:
 * si manda l'indirizzo a qualcuno, quello scrive, e il workflow parte. È il
 * modo più diretto di far entrare dati in un'automazione senza chiedere a
 * nessuno di installare niente.
 *
 * Il problema è che, una volta disegnato, un form **sparisce**: resta un
 * workflow in mezzo agli altri, e per sapere se qualcuno l'ha compilato
 * bisogna ricordarsi quale fosse e aprire le sue esecuzioni. Qui si vedono
 * tutti insieme, con quanti invii hanno ricevuto e l'ultimo quando.
 *
 * L'indirizzo è **locale** come quello dei webhook: `127.0.0.1` non è
 * raggiungibile da internet. Serve a chi sta su questa macchina, o passa da
 * un tunnel. Vedi `webhook.ts` per lo stesso ragionamento.
 */

import { runtimeApi } from './client';

export interface PublicForm {
  workflowId: string;
  workflowName: string;
  /** Un form spento non risponde: l'indirizzo c'è ma restituisce un errore. */
  enabled: boolean;
  nodeId: string;
  /** Il titolo mostrato in cima alla pagina. */
  title: string;
  fieldsCount: number;
  /** Dove si compila. Locale. */
  formUrl: string;
  submissionCount: number;
  /** Quando è arrivato l'ultimo invio, se ne è arrivato uno. */
  lastSubmissionAt: string | null;
}

export interface Submission {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Cosa ha scritto chi ha compilato. */
  input: Record<string, unknown>;
}

/** Tutti i form, dal più usato al meno usato. */
export async function listForms(): Promise<PublicForm[]> {
  const risposta = await runtimeApi.get<{ forms?: PublicForm[] }>('/forms-list');
  const forms = risposta.forms ?? [];
  return [...forms].sort((a, b) => b.submissionCount - a.submissionCount);
}

/** Cosa è arrivato in questo form, dal più recente. */
export async function submissions(workflowId: string, limit = 50): Promise<Submission[]> {
  const risposta = await runtimeApi.get<{ submissions?: Submission[] }>(
    `/forms-list/${workflowId}/submissions?limit=${String(limit)}`,
  );
  return risposta.submissions ?? [];
}
