/**
 * repair-prompt — costruisce il messaggio di RIPARAZIONE per il node-generator.
 *
 * Quando il nodo generato non valida (sintassi/firma/return, costrutti vietati,
 * config key non dichiarata, secret non dichiarato), invece di fallire diamo al
 * modello l'output precedente + l'ELENCO PUNTUALE dei problemi e gli chiediamo
 * SOLO di correggerli, riemettendo lo stesso envelope JSON. È il "rileggi gli
 * errori e sistemali" del loop agentico, applicato alla generazione di codice.
 *
 * Puro: nessun I/O. Testabile in isolamento.
 *
 * @module services/node-generator/repair-prompt
 */

export interface RepairPromptInput {
  /** Descrizione originale del nodo richiesto (per non perdere l'intento). */
  description: string;
  /** Output JSON precedente del modello (envelope {def, executorSource, ...}). */
  previousRaw: string;
  /** Problemi da correggere (messaggi azionabili dei validator). */
  issues: string[];
  language: 'it' | 'en';
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const issuesList = input.issues.map((i) => `- ${i}`).join('\n');
  if (input.language === 'it') {
    return [
      'Il nodo che hai generato ha dei problemi da correggere. NON ripartire da zero:',
      'correggi SOLO i punti elencati e riemetti lo STESSO envelope JSON',
      '(```json con def, executorSource, rationale, warnings?).',
      '',
      `Richiesta originale: ${input.description}`,
      '',
      'Output precedente:',
      input.previousRaw,
      '',
      'Problemi da correggere:',
      issuesList,
      '',
      'Vincoli: l\'executor è `async function execute(config, input, context)`, restituisce',
      'un oggetto, usa SOLO il `fetch` globale e i campi dichiarati in configFields; i secret',
      'vanno letti da context.secrets[...] e dichiarati come configField di type "secret".',
      'VIETATI require/import/eval/Function/process/globalThis/fs/child_process.',
    ].join('\n');
  }
  return [
    'The node you generated has issues to fix. Do NOT start over: fix ONLY the listed',
    'points and re-emit the SAME JSON envelope (```json with def, executorSource, rationale, warnings?).',
    '',
    `Original request: ${input.description}`,
    '',
    'Previous output:',
    input.previousRaw,
    '',
    'Issues to fix:',
    issuesList,
    '',
    'Constraints: the executor is `async function execute(config, input, context)`, returns an',
    'object, uses ONLY the global `fetch` and the keys declared in configFields; secrets are read',
    'from context.secrets[...] and declared as a configField of type "secret".',
    'FORBIDDEN: require/import/eval/Function/process/globalThis/fs/child_process.',
  ].join('\n');
}
