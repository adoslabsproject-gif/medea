# @flowforge/ui-kit

FlowForge design system — TypeScript-typed primitives backed by a single source of truth (CSS variables).

## Philosophy

1. **Design tokens > Tailwind shades.** Components MUST use semantic tokens (`bg-surface`, `text-fg`, `bg-accent`) — NEVER raw shade names (`bg-neutral-900`, `text-blue-400`).
2. **CSS variables = single source of truth.** All token values live in `:root { --surface-base: …; }` inside `apps/editor/src/styles/global.css`. Tailwind reads them at compile time (`rgb(var(--token) / <alpha-value>)`), so a future theme override is one block — zero refactor.
3. **Token contract enforced by tests.** `tokens.test.ts` parses `global.css` and verifies every `:root` var has a matching entry in `DESIGN_TOKENS_CSS_VARS`. Drift = CI failure.
4. **Codemod migration > manual edits.** When you need to change the token strategy, edit `scripts/migrate-design-tokens.mjs` and run it. Versioned, idempotent, reviewable.

## Tokens

```ts
import { SURFACE_LEVELS, type ButtonVariant, surfaceBg, fgText } from '@flowforge/ui-kit';

SURFACE_LEVELS;          // ['base', 'raised', 'subtle', 'hover', 'overlay']
surfaceBg('raised');     // 'bg-surface-raised'
fgText('muted');         // 'text-fg-muted'
```

| Namespace | Levels | Tailwind class examples |
|---|---|---|
| `surface` | base / raised / subtle / hover / overlay | `bg-surface-raised`, `bg-surface/50` |
| `line` | subtle / default / strong | `border-line`, `border-line-strong` |
| `fg` | default / muted / subtle / inverse / on-accent | `text-fg`, `text-fg-muted` |
| `accent` | default / soft / strong | `bg-accent`, `text-accent-soft` |
| `success` | default / soft / strong | `bg-success/15`, `text-success-soft` |
| `danger` | default / soft / strong | `bg-danger/10`, `text-danger` |
| `warning` | default / soft / strong | `bg-warning`, `text-warning-soft` |
| `info` | default / soft / strong | `bg-info`, `text-info-soft` |

## Components

```tsx
import { Button, Card, Input, Badge, Alert, Modal, Dropdown, Tooltip, Spinner } from '@flowforge/ui-kit';

<Card title="My panel" actions={<Button variant="primary">Save</Button>}>
  <Input label="Email" help="we'll never share" />
  <Checkbox label="Send me updates" />
  <Badge variant="success" dot>Active</Badge>
</Card>

<Alert variant="warning" title="Heads up" onDismiss={() => {}}>
  Configuration drift detected.
</Alert>

<Modal open={open} onClose={() => setOpen(false)} title="Confirm" footer={<Button>OK</Button>}>
  Are you sure?
</Modal>
```

Full inventory:

- `<Button variant="primary | secondary | ghost | danger" size="xs|sm|md|lg" leftIcon rightIcon loading block>`
- `<IconButton icon={…} aria-label="…">`
- `<Card title description actions elevated noPadding>`
- `<Input label help error leftAddon rightAddon inputSize>`, `<Textarea>`
- `<Select label help error>`
- `<Checkbox label description>`
- `<Badge variant="neutral | accent | success | danger | warning | info" size="xs|sm|md" dot icon>`
- `<Alert variant title icon onDismiss>`
- `<Modal open onClose title footer size="sm|md|lg|xl|full" persistent>`
- `<Dropdown trigger items={[{id, label, icon, onSelect}, 'separator']} placement>`
- `<Tooltip content placement delay disabled>`
- `<Spinner size>`, `<Skeleton animated>`

## Enforcement

- **CI**: `node scripts/migrate-design-tokens.mjs --check` — fails on drift.
- **Pre-commit**: `.husky/pre-commit` runs the same check on staged files.
- **Tests**: 18 component smoke tests assert variant classes contain semantic tokens (`bg-accent`, `bg-danger`) and NEVER hardcoded shades.
- **Codemod**: `scripts/migrate-design-tokens.mjs` migrates legacy code in one command (idempotent).

## Adding a new token

1. Add the CSS variable to `apps/editor/src/styles/global.css` `:root { … }`.
2. Add the entry to `DESIGN_TOKENS_CSS_VARS` in `tokens.ts`.
3. Add the Tailwind alias in `apps/editor/tailwind.config.js` `colors.{namespace}`.
4. Document the new token here in the README.
5. Run `pnpm -F @flowforge/ui-kit test` — the contract test will catch any sync mistake.

## Adding a new component

1. Create `src/components/MyThing.tsx` — use only semantic token classes.
2. Add an export to `src/index.ts`.
3. Add a smoke test in `src/components/components.test.tsx` — assert the component renders without crashing AND that variant classes contain expected tokens.
4. Document the component here.

## Future

- **Light mode**: override `:root` inside `.light { … }` in `global.css`, toggle via `<html class="light">`. Zero component refactor.
- **Brand themes**: per-tenant theming by injecting tenant-scoped CSS vars in a `<style>` tag at boot.
- **Storybook**: Fase 5 will add visual reference + Playwright snapshots.
