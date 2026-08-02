import { type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { BadgeVariant, Size } from '../tokens.js';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Visual variant — neutral, accent, success, danger, warning, info. */
  variant?: BadgeVariant;
  /** Size — affects padding + text. Defaults to `xs`. */
  size?: Exclude<Size, 'lg'>;
  /** Adds a leading colored dot (typical for "Active", "Error" labels). */
  dot?: boolean;
  /** Leading icon (instead of dot). */
  icon?: ReactNode;
}

const VARIANT: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-hover/40 text-fg-muted',
  accent: 'bg-accent/15 text-accent-soft',
  success: 'bg-success/15 text-success-soft',
  danger: 'bg-danger/15 text-danger-soft',
  warning: 'bg-warning/15 text-warning-soft',
  info: 'bg-info/15 text-info-soft',
};

const DOT_VARIANT: Record<BadgeVariant, string> = {
  neutral: 'bg-fg-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning',
  info: 'bg-info',
};

const SIZE: Record<'xs' | 'sm' | 'md', string> = {
  xs: 'h-4 px-1.5 text-[10px] gap-1',
  sm: 'h-5 px-2 text-[11px] gap-1.5',
  md: 'h-6 px-2.5 text-xs gap-1.5',
};

/**
 * Badge — small label for status, count, or category.
 * Uses semantic tokens via `variant`. NEVER pass raw colors.
 */
export function Badge({
  variant = 'neutral',
  size = 'xs',
  dot,
  icon,
  className,
  children,
  ...rest
}: BadgeProps): React.ReactElement {
  return (
    <span
      className={clsx(
        'inline-flex select-none items-center rounded-md font-medium',
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_VARIANT[variant])} aria-hidden />
      )}
      {icon !== undefined && !dot && <span aria-hidden>{icon}</span>}
      {children}
    </span>
  );
}
