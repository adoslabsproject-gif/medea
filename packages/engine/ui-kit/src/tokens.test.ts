/**
 * Token contract test — Federico-grade single-source-of-truth enforcement.
 *
 * Verifies that:
 *   1. Every CSS variable declared in apps/editor/src/styles/global.css
 *      `:root { ... }` also appears in DESIGN_TOKENS_CSS_VARS.
 *   2. Every name in DESIGN_TOKENS_CSS_VARS is declared in global.css.
 *
 * If either side drifts, the test fails — preventing the silent rot where
 * someone adds a CSS var but forgets the TS contract (or vice versa).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DESIGN_TOKENS_CSS_VARS } from './tokens.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadGlobalCss(): string {
  // packages/flowforge/ui-kit/src → apps/flowforge-editor/src/styles/global.css
  // (4 livelli su dal pkg ui-kit nel monorepo zeliAI post-merge)
  const path = resolve(__dirname, '../../../../apps/flowforge-editor/src/styles/global.css');
  return readFileSync(path, 'utf8');
}

/** Extract `--variable-name` declarations inside the first `:root { ... }` block. */
function extractRootVars(css: string): string[] {
  const rootMatch = /:root\s*\{([\s\S]*?)\}/u.exec(css);
  if (!rootMatch) return [];
  const body = rootMatch[1] ?? '';
  const found: string[] = [];
  const re = /(--[a-z][a-z0-9-]*)\s*:/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) found.push(m[1]);
  }
  return found;
}

describe('design tokens — single source of truth contract', () => {
  it('every CSS :root variable is declared in DESIGN_TOKENS_CSS_VARS', () => {
    const cssVars = extractRootVars(loadGlobalCss());
    // Filter out side-quantities (--focus-ring etc.) that we intentionally
    // keep out of the TS contract because they aren't Tailwind-color tokens.
    const colorVars = cssVars.filter((v) =>
      /^--(surface|line|fg|accent|success|danger|warning|info)-/u.test(v),
    );
    for (const v of colorVars) {
      expect(DESIGN_TOKENS_CSS_VARS).toContain(v);
    }
  });

  it('every name in DESIGN_TOKENS_CSS_VARS exists as :root var in global.css', () => {
    const cssVars = new Set(extractRootVars(loadGlobalCss()));
    for (const tokenName of DESIGN_TOKENS_CSS_VARS) {
      expect(cssVars.has(tokenName)).toBe(true);
    }
  });
});
