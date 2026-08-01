import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { ButtonVariant, Size } from '../tokens.js';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Visual style. Defaults to `secondary`. */
  variant?: ButtonVariant;
  /** Size — affects padding + text. Defaults to `sm`. */
  size?: Size;
  /** When true, renders a spinner and disables the button. */
  loading?: boolean;
  /** Leading icon (rendered before children). */
  leftIcon?: ReactNode;
  /** Trailing icon (rendered after children). */
  rightIcon?: ReactNode;
  /** Native button type — defaults to 'button' (never accidentally submit a form). */
  type?: 'button' | 'submit' | 'reset';
  /** Render the button at 100% of parent width. */
  block?: boolean;
}

/**
 * Variants are CSS-only — Tailwind classes built from semantic tokens.
 * No inline shade names (`bg-blue-500`), no fluo colors. Federico-grade.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-fg-on-accent shadow-soft hover:bg-accent-strong active:bg-accent-strong/90 disabled:bg-accent/40',
  secondary:
    'border border-line-strong bg-surface-raised text-fg hover:bg-surface-subtle hover:border-line-strong active:bg-surface-hover disabled:opacity-50',
  ghost:
    'text-fg-muted hover:bg-surface-subtle hover:text-fg active:bg-surface-hover disabled:opacity-40',
  danger:
    'border border-danger/40 bg-danger/10 text-danger-soft hover:bg-danger/20 active:bg-danger/30 disabled:opacity-40',
};

const SIZE: Record<Size, string> = {
  xs: 'h-6 gap-1 px-2 text-[10px]',
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-9 gap-2 px-3.5 text-sm',
  lg: 'h-11 gap-2 px-5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', loading, leftIcon, rightIcon, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading === true}
      className={clsx(
        'inline-flex select-none items-center justify-center rounded-md font-medium transition disabled:cursor-not-allowed',
        SIZE[size],
        VARIANT[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leftIcon}
      {children !== undefined && children !== null && <span>{children}</span>}
      {!loading && rightIcon}
    </button>
  );
});

function Spinner(): React.ReactElement {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'leftIcon' | 'rightIcon' | 'children'> {
  /** Icon node (the only content). */
  icon: ReactNode;
  /** Required for a11y — describes what the button does. */
  'aria-label': string;
}

/** Square button containing a single icon. Same variant/size API as Button. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = 'ghost', size = 'sm', className, ...rest },
  ref,
) {
  const SIZE_SQUARE: Record<Size, string> = {
    xs: 'h-6 w-6',
    sm: 'h-7 w-7',
    md: 'h-9 w-9',
    lg: 'h-11 w-11',
  };
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      className={clsx('!px-0', SIZE_SQUARE[size], className)}
      {...rest}
    >
      <span aria-hidden>{icon}</span>
    </Button>
  );
});
