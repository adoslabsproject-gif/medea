import { forwardRef, type SelectHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Size } from '../tokens.js';

const SIZE: Record<Size, string> = {
  xs: 'h-6 text-[10px] px-1.5 pr-7',
  sm: 'h-7 text-xs px-2 pr-7',
  md: 'h-9 text-sm px-2.5 pr-8',
  lg: 'h-11 text-base px-3 pr-10',
};

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: ReactNode;
  help?: ReactNode;
  error?: string;
  inputSize?: Size;
}

/** Native <select> styled with the design system tokens. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, help, error, inputSize = 'sm', className, id, children, ...rest },
  ref,
) {
  const selectId = id ?? rest.name ?? `select-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className="w-full">
      {label !== undefined && (
        <label htmlFor={selectId} className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-fg-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          className={clsx(
            'w-full appearance-none rounded-md border bg-surface-raised text-fg outline-none transition focus:border-accent',
            SIZE[inputSize],
            error ? 'border-danger/60' : 'border-line-strong',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </div>
      {error !== undefined ? (
        <p className="mt-1 text-[10px] text-danger-soft">{error}</p>
      ) : help !== undefined ? (
        <p className="mt-1 text-[10px] text-fg-subtle">{help}</p>
      ) : null}
    </div>
  );
});
