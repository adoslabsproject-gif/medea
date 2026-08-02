# @medea/engine-community-node-sdk

Type-safe builder + CLI per pacchetti FlowForge community-node (.ffnode).

## Installazione

```bash
npm install --save-dev @medea/engine-community-node-sdk tsx
```

## Esempio

```ts
// src/index.ts
import { defineCommunityNode, action } from '@medea/engine-community-node-sdk';

export default defineCommunityNode({
  manifest: {
    id: 'my_node',
    vendor: 'my-company',
    version: '1.0.0',
    displayName: 'My Node',
    description: 'Cosa fa il mio nodo',
    license: 'MIT',
    category: 'Document',
    homepage: 'https://my-company.example.com',
  },
  def: {
    type: 'action',
    icon: 'cube',
    color: '#3b82f6',
    // Configurazione condivisa a tutte le actions (es. API key)
    configFields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
  },
  actions: [
    action({
      id: 'do_thing',
      label: 'Do Thing',
      description: 'Spiegazione corta visibile nel picker',
      category: 'Document',
      configFields: [{ key: 'input', label: 'Input', type: 'text', required: true }],
      async execute(config, input, context) {
        // config = { apiKey, input, __action: 'do_thing', ... }
        // input  = output del nodo upstream
        // context = { tenantId, runId, workflowId, nodeId, action }
        const apiKey = String(config.apiKey || '');
        const arg = String(config.input || '');
        const res = await fetch('https://api.example.com/things', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ arg }),
        });
        if (!res.ok) throw new Error('API ' + res.status);
        return await res.json();
      },
    }),
    action({
      id: 'do_ai_thing',
      label: 'Do AI Thing',
      aiAction: true, // Mostra badge "✨ AI" in marketplace
      category: 'AI',
      async execute(config, input) {
        // ... chiamata LLM
        return { result: 'analyzed' };
      },
    }),
  ],
});
```

## Build

```bash
npx ffnode-build src/index.ts --out dist
```

Output:

- `dist/<id>-<version>.ffnode` — pacchetto zippato e firmato
- `dist/registry-entry.json` — snippet da splicare nel registry

## Firma

Per produrre pacchetti con badge "✓ Verified":

```bash
openssl genpkey -algorithm ed25519 -out .signing-key.pem
echo ".signing-key.pem" >> .gitignore
```

Oppure passa la chiave via env:

```bash
MEDEA_NODE_SIGNING_KEY="$(cat private.pem)" npx ffnode-build src/index.ts
```

Senza chiave persistente, il CLI genera una chiave dev ephemera e marca `verified: false` nel registry-entry.

## API del sandbox

Dentro l'`execute`:

- ✅ `fetch(url, init)` — proxied al host runtime
- ✅ `console.log/warn/error` — capturati nel logger del runtime
- ✅ `JSON`, `Math`, `Date`, `URL`, `URLSearchParams`, `Promise`, `setTimeout`, `clearTimeout`
- ✅ `Buffer.from(str, enc).toString(enc)` — shim 2-metodi (base64/utf8)

- ❌ `process`, `require`, `import`, `fs`, `child_process`
- ❌ `globalThis` accesso al main thread
- ❌ Memory > 128 MB → V8 OOM dell'isolate (l'host sopravvive)
- ❌ Tempo di esecuzione > 30s → timeout

## Publish

Manda il `.ffnode` al maintainer del registry (issue/PR sul repo FlowForge community):

```bash
# Mirror locale per testare l'install
node -e "
const fs = require('fs');
const buf = fs.readFileSync('./dist/my_node-1.0.0.ffnode');
console.log({ url: 'https://...', base64: buf.toString('base64').slice(0, 80) + '...' });
"
```

oppure usa `community-nodes/publish.mjs` nel repo FlowForge.

## Licenza

MIT.
