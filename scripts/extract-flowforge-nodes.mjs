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
          })),
        }
      : {}),
    ...(Array.isArray(d.actions) && d.actions.length > 0
      ? { actions: d.actions.map((a) => ({ id: a.id, ...(a.label ? { label: a.label } : {}) })) }
      : {}),
    ...(Array.isArray(d.outputs) && d.outputs.length > 0
      ? { outputPorts: d.outputs.map((o) => (typeof o === 'string' ? o : (o.id ?? o.name))) }
      : {}),
  }));

writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log(`${out.length} nodi estratti`);
const byType = {};
for (const d of out) byType[d.type] = (byType[d.type] ?? 0) + 1;
console.log(byType);
