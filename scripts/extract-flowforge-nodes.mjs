/**
 * Estrae le definizioni dei nodi dalla stdlib compilata di FlowForge.
 *
 * Le descrizioni originali sono lunghe migliaia di caratteri: servono al
 * modello sul server, non alla palette. Qui si tiene la prima frase.
 *
 * I pacchetti espongono i nodi in due forme diverse: alcuni un oggetto per
 * nodo, altri un unico array `stdlibNodes` con tutto dentro. Guardare solo la
 * prima ne faceva sparire 48 su 193 — fra cui tutti gli `agent_*` e le
 * utilità di trasformazione. Un estrattore che ne prende una parte e tace è
 * peggio di uno che fallisce: il catalogo sembra completo.
 */
import { writeFileSync } from 'node:fs';

/**
 * Dove sta il repository di FlowForge, da cui si leggono i pacchetti
 * compilati.
 *
 * Arriva dall'ambiente e non è scritto qui dentro: un percorso che esiste su
 * una macchina sola è una bugia che funziona finché non la si prova altrove —
 * e, in un repository pubblico, dice a chiunque come sono organizzate le
 * cartelle di chi lo ha scritto.
 *
 * Uso:
 *   FLOWFORGE_SRC=/percorso/a/zeliAI node scripts/extract-flowforge-nodes.mjs <destinazione>
 */
const SORGENTE = process.env.FLOWFORGE_SRC;
if (!SORGENTE) {
  console.error(
    'Manca FLOWFORGE_SRC: indica la radice del repository di FlowForge.\n' +
      '  FLOWFORGE_SRC=/percorso/a/zeliAI node scripts/extract-flowforge-nodes.mjs <destinazione>',
  );
  process.exit(1);
}

const PACKAGES = ['stdlib', 'db', 'ai-agents', 'llm', 'integrations-core', 'integrations-italia'];

const defs = new Map();

/** Vero se questo è davvero un nodo e non una funzione di supporto. */
const isNode = (value) =>
  value &&
  typeof value === 'object' &&
  value.def &&
  typeof value.def.id === 'string' &&
  typeof value.def.type === 'string';

/** Raccoglie da un valore esportato, qualunque forma abbia. */
const take = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 2) return;
  if (isNode(value)) {
    defs.set(value.def.id, value.def);
    return;
  }
  // Un array di nodi (`stdlibNodes`), o un oggetto che li raggruppa.
  for (const inner of Array.isArray(value) ? value : Object.values(value)) {
    take(inner, depth + 1);
  }
};

const collect = (mod) => {
  for (const value of Object.values(mod)) take(value);
};

for (const pkg of PACKAGES) {
  try {
    collect(await import(`${SORGENTE}/packages/flowforge/nodes/${pkg}/dist/index.js`));
  } catch (e) {
    console.warn(`salto ${pkg}: ${e.message.split('\n')[0]}`);
  }
}

/**
 * La prima frase: è quella che sta in una riga di palette.
 *
 * Non sostituisce l'originale — la accompagna. Troncare e basta indeboliva la
 * ricerca dell'assistente, che di quel testo si serve per capire cosa fa un
 * nodo prima di sceglierlo.
 */
const firstSentence = (text) => {
  if (typeof text !== 'string') return undefined;
  const cut = text.split(/(?<=[.—])\s/)[0] ?? text;
  return cut.length > 240 ? `${cut.slice(0, 237)}…` : cut;
};

/** Il testo per esteso, quando dice più della prima frase. */
const fullDescription = (text) => {
  if (typeof text !== 'string' || !text) return undefined;
  return text === firstSentence(text) ? undefined : text;
};

const out = [...defs.values()]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((d) => ({
    defId: d.id,
    type: d.type,
    label: d.label,
    ...(d.icon ? { icon: d.icon } : {}),
    ...(d.color ? { color: d.color } : {}),
    ...(firstSentence(d.description) ? { description: firstSentence(d.description) } : {}),
    // Il testo per esteso: serve all'assistente per capire cosa fa un nodo
    // prima di sceglierlo. La palette continua a mostrare `description`.
    ...(fullDescription(d.description) ? { descriptionLong: d.description } : {}),
    // La versione della DEFINIZIONE, non del pacchetto: è quella che permette
    // di accorgersi che un workflow salvato mesi fa usa un nodo cambiato da
    // allora. Senza, la deriva passa inosservata.
    ...(d.version ? { defVersion: d.version } : {}),
    // Le parole con cui un nodo si cerca ma che nel nome non compaiono:
    // «wa» per WhatsApp, «posta» per email. Senza, la ricerca trova solo chi
    // già sa come si chiama la cosa.
    ...(Array.isArray(d.searchAliases) && d.searchAliases.length > 0
      ? { searchAliases: [...d.searchAliases] }
      : {}),
    // Cosa produce davvero, campo per campo. Serve a non far inventare
    // all'assistente i nomi delle chiavi quando scrive un'espressione.
    ...(d.outputContract ? { outputContract: d.outputContract } : {}),
    // Il nodo si riprova da sé: il motore non deve rifarlo, e il pannello dei
    // tentativi non deve offrirlo.
    ...(d.selfManagedRetry ? { selfManagedRetry: true } : {}),
    ...(Array.isArray(d.configFields) && d.configFields.length > 0
      ? {
          configFields: d.configFields.map((f) => ({
            key: f.key,
            ...(f.label ? { label: f.label } : {}),
            type: f.type,
            ...(f.required ? { required: true } : {}),
            ...(Array.isArray(f.options) && f.options.length > 0
              ? { options: f.options.map((o) => (typeof o === 'string' ? o : o.value)) }
              : {}),
            ...(f.pattern ? { pattern: f.pattern } : {}),
            // Cosa dire quando il valore non rispetta il pattern. Senza, il
            // messaggio è l'espressione regolare — che non aiuta nessuno.
            ...(f.patternMessage ? { patternMessage: f.patternMessage } : {}),
            // In che lingua è scritto un campo di codice. Lo usano la regola
            // di qualità CODE_NODE_LANG_MISMATCH e l'editor per evidenziare:
            // senza, un blocco SQL e uno JavaScript sono la stessa casella.
            ...(f.language ? { language: f.language } : {}),
            ...(f.defaultValue !== undefined && f.defaultValue !== ''
              ? { defaultValue: String(f.defaultValue) }
              : {}),
            // showIf e' cio' che tiene leggibile un pannello da 30 campi:
            // host/porta/utente/password compaiono solo se NON si e' scelto
            // un account. Senza, il pannello li mostra tutti sempre.
            ...(f.showIf ? { showIf: f.showIf } : {}),
            ...(f.dependsOn ? { dependsOn: f.dependsOn } : {}),
            ...(f.placeholder ? { placeholder: f.placeholder } : {}),
            // `help` diventa la descrizione mostrata sotto il campo: e' la
            // frase che spiega cosa scriverci.
            ...(f.help ? { description: f.help } : {}),
          })),
        }
      : {}),
    ...(Array.isArray(d.actions) && d.actions.length > 0
      ? { actions: d.actions.map((a) => ({ id: a.id, ...(a.label ? { label: a.label } : {}) })) }
      : {}),
    // `branching` distingue le PORTE dai CAMPI. Un logic_if ha due porte
    // (true/false) e sono due strade diverse; un meta_extract ha diciassette
    // "outputs" che sono i campi del suo risultato, non diciassette strade.
    // Disegnarli tutti come porte e' esattamente il pasticcio da evitare.
    ...(d.branching ? { branching: true } : {}),
    ...(Array.isArray(d.outputs) && d.outputs.length > 0
      ? {
          [d.branching ? 'outputPorts' : 'outputFields']: d.outputs.map((o) =>
            typeof o === 'string' ? o : (o.id ?? o.name),
          ),
        }
      : {}),
  }));

// La riga a capo finale non è un vezzo: senza, il controllo di formato
// della CI boccia il file a ogni rigenerazione.
writeFileSync(process.argv[2], `${JSON.stringify(out, null, 2)}\n`);
console.log(`${out.length} nodi estratti`);
const byType = {};
for (const d of out) byType[d.type] = (byType[d.type] ?? 0) + 1;
console.log(byType);
