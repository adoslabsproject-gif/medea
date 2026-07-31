# ADR 0003 — Design system: OKLCH + `light-dark()` + `@layer`

- **Status**: Accepted
- **Date**: 2026-05-25
- **Deciders**: Owner del prodotto + Claude

## Contesto

L'utente ha chiesto esplicitamente CSS «strutturati nella maniera più avanzata e scalabile, [in modo da] evitare problemi di modifiche di riquadri o se vuoi cambiare la palette». In altre parole: cambiare colore al brand non deve rompere componenti, e ogni modifica grafica deve essere prevedibile.

Il materiale di partenza (`nha-ui/src/styles/tokens.css`) è **52 righe di valori hex hard-coded**, palette solo-dark, niente layers, niente container queries, niente light mode. Cambiare un colore richiede di toccare N componenti.

## Decisione

Adottiamo **tre pilastri CSS 2026** insieme:

### 1. OKLCH come spazio colore primitivo

Tutti i valori sorgente nei file `packages/design-system/tokens/*.json` sono dichiarati in `oklch(L C H)`. L=Lightness percettiva, C=Chroma, H=Hue. Perché:

- Variazioni di lightness sono _percettivamente uniformi_: una scala `--indigo-500` → `--indigo-600` ha sempre lo stesso "salto" perceivable, indipendentemente dall'hue. Con HSL non è vero (giallo e blu allo stesso L appaiono molto diversi).
- Il browser interpola colori in OKLCH in `color-mix()` senza il bandaggio tipico dell'RGB.
- Permette palette generative (variando solo H si ottengono famiglie coerenti).

Cambiare la palette del brand = modificare 6 valori H nei file JSON e ribuildare.

### 2. `light-dark()` nativo per i token semantici

I token semantici (es. `--color-surface-1`, `--color-text-primary`) sono definiti UNA volta come:

```css
--color-surface-1: light-dark(oklch(0.99 0.005 270), oklch(0.16 0.01 270));
```

Il browser sceglie automaticamente in base a `color-scheme` + `data-theme` opzionale. Vantaggi:

- Niente media query duplicate `@media (prefers-color-scheme: dark)` sparse nei componenti.
- Nessun runtime overhead — è il browser che fa lo switch.
- Forzare un tema = `<html data-theme="light">` (o `dark` o `hc`).

### 3. CSS `@layer` per controllare la cascade

Dichiariamo l'ordine ufficiale in `packages/design-system/src/layers.css`:

```css
@layer reset, tokens, base, themes, components, features, utilities, overrides;
```

Ogni regola CSS DEVE appartenere a un layer. Questo elimina la guerra di specificità senza ricorrere a `!important`. Un componente in `@layer components` non può venire sovrascritto «per caso» da una utility class. La layer `overrides` è riservata a hot-fix puntuali e richiede commento motivazionale obbligatorio (lint custom).

## Aggiunte coerenti

- **Container queries** (`@container`) invece di `@media`: i componenti rispondono al **proprio container**, non al viewport. La stessa `<MessageList>` montata in `apps/desktop` e in `apps/mobile` adatta il layout senza duplicazione media-query.
- **CSS Anchor positioning** (nativo nelle WebView 2026) per Tooltip/Popover/Menu — niente `floating-ui` come dipendenza salvo fallback.
- **View Transitions API** per cambi di route e selezione messaggio, registrate in `tokens/motion.json`.
- **Style Dictionary o builder zero-dep**: per Fase 0 abbiamo un builder Node nativo (`packages/design-system/tokens.config.mjs`, 0 dipendenze). Quando i target multipli (Figma Sync, Compose, Swift) diventeranno reali, si passa a Style Dictionary senza cambiare i sorgenti JSON.

## Conseguenze

### Positive

- Cambiare palette = `git diff` su 6 valori in `color.json` + `pnpm tokens:build`.
- Nessun componente vede mai un hex raw — ESLint lo blocca via `no-restricted-syntax`.
- Light/dark/HC vivono in un solo file di token; aggiungere un tema = 1 selettore `[data-theme="x"]` con override delle coppie semantiche critiche.
- Layout responsive senza media query duplicate.

### Negative

- OKLCH richiede WebView aggiornata. Tauri 2 usa WebView2 (Win) + WKWebView (macOS) + WebView Android System: target 2026 supportano tutti OKLCH e `light-dark()`. Niente fallback HSL/HEX salvo decisione esplicita di supporto LTS.
- Sviluppatori che vengono da Tailwind devono adattarsi alla disciplina dei semantic tokens.

### Vincoli operativi

- Niente hex hard-coded nei componenti. ESLint `no-restricted-syntax` blocca i literal `#[0-9a-fA-F]{3,8}`. Eccezioni vivono nei file `tokens/*.json` o richiedono pragma esplicito.
- Niente `z-index` magic numbers. La scala è in `tokens/z-index.json`, mai inline.
- Nessuna animazione senza rispettare `prefers-reduced-motion: reduce` (gestito nel reset).

## Riferimenti

- OKLCH: https://oklch.com/
- `light-dark()` native: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark
- CSS `@layer`: https://developer.mozilla.org/en-US/docs/Web/CSS/@layer
- CSS Container Queries: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries
- View Transitions API: https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API
- Style Dictionary: https://amzn.github.io/style-dictionary/
