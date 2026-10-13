/**
 * Dire all'utente, con parole valutabili, cosa Claude Code sta per fare.
 *
 * «Posso usare Bash?» non è una domanda a cui si possa rispondere. «Posso
 * eseguire `rm -rf build`?» sì. Qui si tira fuori dalla richiesta della CLI
 * la cosa concreta: il comando, il file, l'indirizzo.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function testo(input: unknown, campo: string): string | null {
  if (!isRecord(input)) return null;
  const v = input[campo];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Accorcia un testo lungo tenendone l'inizio, che è quello che conta. */
function accorcia(valore: string, massimo = 400): string {
  return valore.length > massimo ? `${valore.slice(0, massimo)}…` : valore;
}

export function descriviPermesso(toolName: string, input: unknown): string {
  const comando = testo(input, 'command');
  const file = testo(input, 'file_path') ?? testo(input, 'notebook_path') ?? testo(input, 'path');
  const url = testo(input, 'url');

  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return comando
        ? `eseguire sul tuo computer il comando:\n${accorcia(comando)}`
        : 'eseguire un comando sul tuo computer';
    case 'Write':
      return file ? `creare o sovrascrivere il file ${file}` : 'scrivere un file';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `modificare il file ${file}` : 'modificare un file';
    case 'Read':
      return file ? `leggere il file ${file}` : 'leggere un file fuori dalla cartella di lavoro';
    case 'WebFetch':
      return url ? `aprire la pagina ${accorcia(url)}` : 'aprire una pagina web';
    default: {
      // Uno strumento che non conosciamo: si mostra com'è, senza inventare
      // una frase che potrebbe dire una cosa diversa da quella che farà.
      let dettagli = '';
      try {
        dettagli = accorcia(JSON.stringify(input ?? {}), 300);
      } catch {
        dettagli = '';
      }
      return dettagli && dettagli !== '{}'
        ? `usare lo strumento ${toolName} con: ${dettagli}`
        : `usare lo strumento ${toolName}`;
    }
  }
}
