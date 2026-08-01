/**
 * Cosa fa davvero «aspetta» su un nodo subworkflow.
 *
 * Il campo si chiama così, ma il motore risponde appena la nuova esecuzione è
 * in coda — è asincrono di proposito, per non morire sui workflow che durano
 * minuti. Il chiamato gira e finisce; il chiamante non lo sa, e riceve
 * un'esecuzione appena nata invece del risultato.
 *
 * Dirlo qui costa tre righe. Non dirlo significa che qualcuno costruirà un
 * flusso che legge il risultato del figlio, non lo troverà, e cercherà
 * l'errore ovunque tranne che nel significato di una parola.
 */

import styles from './SubworkflowNote.module.css';

export function SubworkflowNote({ config }: { config: Record<string, unknown> }) {
  const aspetta = config.wait !== 'false' && config.wait !== false;
  if (!aspetta) return null;

  return (
    <p className={styles.root}>
      <strong>«Aspetta» non aspetta ancora.</strong> Il workflow chiamato parte e arriva in fondo,
      ma questo nodo riceve solo il suo identificativo — non il risultato. Per usare quel risultato,
      per ora, serve leggerlo dallo storico del workflow chiamato.
    </p>
  );
}
