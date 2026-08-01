/**
 * Design tokens — TypeScript contract.
 *
 * These constants MIRROR the CSS variables defined in
 * `apps/editor/src/styles/global.css` (`:root { --surface-base: …; }`).
 *
 * The two files MUST stay in sync — `tokens.test.ts` enforces this by
 * parsing global.css and comparing var names.
 *
 * Purpose:
 *   1. Autocomplete + type-checking in JSX (`<Card surface="raised" />`).
 *   2. Documentation: hover any token in your IDE to see what it means.
 *   3. Future runtime theming — `setTokens({ accent: '#...' })`.
 *   4. Lint rule (Fase 4) can verify that JSX classNames only use these
 *      token names, never raw `bg-zinc-900` or `text-blue-400`.
 *
 * Federico-grade contract: every Tailwind color name we expose corresponds
 * to one (and only one) entry here. No magic strings, no inline shades.
 */

/** Background surfaces, layered base → hover. */
export const SURFACE_LEVELS = ['base', 'raised', 'subtle', 'hover', 'overlay'] as const;
export type SurfaceLevel = (typeof SURFACE_LEVELS)[number];

/** Border/line weights. */
export const LINE_LEVELS = ['subtle', 'default', 'strong'] as const;
export type LineLevel = (typeof LINE_LEVELS)[number];

/** Text foreground variants, primary → most muted. */
export const FG_LEVELS = ['default', 'muted', 'subtle', 'inverse', 'on-accent'] as const;
export type FgLevel = (typeof FG_LEVELS)[number];

/** Accent / status palette weights — `soft` is lighter, `strong` is bolder. */
export const TONE_LEVELS = ['default', 'soft', 'strong'] as const;
export type ToneLevel = (typeof TONE_LEVELS)[number];

/** Status namespace — every status color has the same `ToneLevel` shape. */
export const STATUS_NAMES = ['accent', 'success', 'danger', 'warning', 'info'] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

/** Sizes for ui-kit primitives (Button, Input, Badge, IconButton, …). */
export const SIZE_LEVELS = ['xs', 'sm', 'md', 'lg'] as const;
export type Size = (typeof SIZE_LEVELS)[number];

/** Button visual variants. */
export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/** Badge visual variants — mirrors status names + neutral. */
export const BADGE_VARIANTS = ['neutral', ...STATUS_NAMES] as const;
export type BadgeVariant = (typeof BADGE_VARIANTS)[number];

/** Alert visual variants — same as status names. */
export type AlertVariant = StatusName;

/**
 * Complete inventory of CSS variable names this design system defines.
 * Used by `tokens.test.ts` to validate the global.css contract.
 */
export const DESIGN_TOKENS_CSS_VARS = [
  // Surfaces
  '--surface-base',
  '--surface-raised',
  '--surface-subtle',
  '--surface-hover',
  '--surface-overlay',
  // Lines
  '--line-subtle',
  '--line-default',
  '--line-strong',
  // Foreground
  '--fg-default',
  '--fg-muted',
  '--fg-subtle',
  '--fg-inverse',
  '--fg-on-accent',
  // Accent + status (every status × every tone)
  '--accent-default',
  '--accent-soft',
  '--accent-strong',
  '--success-default',
  '--success-soft',
  '--success-strong',
  '--danger-default',
  '--danger-soft',
  '--danger-strong',
  '--warning-default',
  '--warning-soft',
  '--warning-strong',
  '--info-default',
  '--info-soft',
  '--info-strong',
] as const;

/**
 * Class-name helpers — returns the Tailwind class for a given semantic
 * token. Components SHOULD use these instead of inlining `bg-surface-raised`
 * directly, so that a rename of the token only touches this file.
 *
 * Example:
 *   <div className={surfaceBg('raised')}>…</div>
 */
export const surfaceBg = (level: SurfaceLevel = 'base'): string =>
  level === 'base' ? 'bg-surface' : `bg-surface-${level}`;

export const lineBorder = (level: LineLevel = 'default'): string =>
  level === 'default' ? 'border-line' : `border-line-${level}`;

export const fgText = (level: FgLevel = 'default'): string =>
  level === 'default' ? 'text-fg' : `text-fg-${level}`;

export const tonePalette = (name: StatusName, level: ToneLevel = 'default'): string =>
  level === 'default' ? name : `${name}-${level}`;

export const toneBg = (name: StatusName, level: ToneLevel = 'default'): string =>
  `bg-${tonePalette(name, level)}`;

export const toneText = (name: StatusName, level: ToneLevel = 'default'): string =>
  `text-${tonePalette(name, level)}`;

export const toneBorder = (name: StatusName, level: ToneLevel = 'default'): string =>
  `border-${tonePalette(name, level)}`;
