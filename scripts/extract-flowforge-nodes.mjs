/**
 * Estrae le definizioni dei nodi dalla stdlib compilata di FlowForge.
 *
 * Le descrizioni originali sono lunghe migliaia di caratteri: servono al
 * modello sul server, non alla palette. Qui si tiene la prima frase.
 */
import { writeFileSync } from 'node:fs';

const PACKAGES = [
  'stdlib',
  'db',
  'ai-agents',
  'llm',
  'integrations-core',
  'integrations-italia',
];

const defs = new Map();
const collect = (mod) => {
  for (const value of Object.values(mod)) {
    if (!value || typeof value !== 'object') continue;
    const def = value.def;
    if (!def || typeof def.id !== 'string' || typeof def.type !== 'string') continue;
    defs.set(def.id, def);
  }
};

for (const pkg of PACKAGES) {
  try {
    collect(
      await import(`/Users/zelistore/zeliAI/packages/flowforge/nodes/${pkg}/dist/index.js`),
    );
  } catch (e) {
    console.warn(`salto ${pkg}: ${e.message.split('\n')[0]}`);
  }
}

const firstSentence = (text) => {
  if (typeof text !== 'string') return undefined;
  const cut = text.split(/(?<=[.—])\s/)[0] ?? text;
  return cut.length > 240 ? `${cut.slice(0, 237)}…` : cut;
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

writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log(`${out.length} nodi estratti`);
const byType = {};
for (const d of out) byType[d.type] = (byType[d.type] ?? 0) + 1;
console.log(byType);
