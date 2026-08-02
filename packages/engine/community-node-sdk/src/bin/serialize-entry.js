#!/usr/bin/env node
/**
 * Helper invoked by ffnode-build when the entry is a .ts file.
 *
 * Imports the TypeScript entry via the tsx loader (registered by the
 * caller via `node --import tsx`), grabs the default export, and prints
 * a JSON-serializable snapshot of it. The execute functions are stringified
 * so they survive the JSON round-trip (the SDK's compile() rehydrates them
 * via Function reconstruction is NOT needed — we keep them as strings and
 * inline directly into executor.js).
 *
 * Why a separate process: tsx is a child-process-friendly loader and we
 * don't want to bring TS into the SDK's own runtime — vendors should
 * compile once and ship JS.
 */

import { pathToFileURL } from 'node:url';

async function main() {
  const entry = process.argv[2];
  if (!entry) {
    console.error('Usage: serialize-entry.js <entry.ts>');
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  const spec = mod.default;
  if (!spec) {
    console.error('serialize-entry: ' + entry + ' has no default export.');
    process.exit(1);
  }

  // Functions don't survive JSON.stringify by default. We stash them
  // as strings under a sibling field that compile() will pick up.
  const serializable = JSON.parse(
    JSON.stringify(spec, (_k, v) => {
      if (typeof v === 'function') return { __fn: v.toString() };
      return v;
    }),
  );

  // Rehydrate function strings back into the structure expected by compile().
  // The SDK's compile() calls .toString() on each action.execute, so we wrap
  // the __fn strings into objects with a toString() method.
  function rehydrate(node) {
    if (Array.isArray(node)) return node.map(rehydrate);
    if (node && typeof node === 'object') {
      if (node.__fn) return { toString: () => node.__fn };
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = rehydrate(v);
      return out;
    }
    return node;
  }
  const rehydrated = rehydrate(serializable);

  // Compile is run here because the SDK lives in the same package — but
  // compile expects real functions for action.execute. We've replaced
  // them with toString-only stubs above. Run compile by hand in the
  // CLI process (where compile is imported normally).
  // Just emit the structure; ffnode-build re-imports compile in its own
  // process and calls it.
  process.stdout.write(JSON.stringify(rehydrated));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
