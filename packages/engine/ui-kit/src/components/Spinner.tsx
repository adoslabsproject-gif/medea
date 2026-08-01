import clsx from 'clsx';
import type { Size } from '../tokens.js';

export interface SpinnerProps {
  size?: Size;
  /** Color — defaults to current text color (`text-current`). */
  className?: string;
  /** A11y label — defaults to "Loading…". */
  label?: string;
}

const SIZE_PX: Record<Size, number> = {
  xs: 12,
  sm: 14,
  md: 18,
  lg: 24,
};

/** Inline loading spinner. Use inside buttons or as standalone indicator. */
export function Spinner({ size = 'sm', className, label = 'Loading…' }: SpinnerProps): React.ReactElement {
  const px = SIZE_PX[size];
  return (
    <svg
      className={clsx('animate-spin text-current', className)}
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export interface SkeletonProps {
  className?: string;
  /** When true (default) shows a pulse animation. */
  animated?: boolean;
}

/** Skeleton placeholder for content loading. Use during data fetches. */
export function Skeleton({ className, animated = true }: SkeletonProps): React.ReactElement {
  return (
    <div
      className={clsx(
        'rounded-md bg-surface-subtle',
        animated && 'animate-pulse',
        className,
      )}
      aria-hidden
    />
  );
}
