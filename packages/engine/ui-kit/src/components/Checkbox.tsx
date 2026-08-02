import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size'
> {
  label?: ReactNode;
  description?: ReactNode;
}

/**
 * Styled checkbox with optional label + description. Uses the native
 * input under the hood for full keyboard/screen-reader support.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, disabled, ...rest },
  ref,
) {
  const inputId = id ?? rest.name ?? `cb-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <label
      htmlFor={inputId}
      className={clsx(
        'flex cursor-pointer items-start gap-2 select-none',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        disabled={disabled}
        className="peer mt-0.5 h-3.5 w-3.5 cursor-pointer appearance-none rounded border border-line-strong bg-surface-raised transition checked:border-accent checked:bg-accent disabled:cursor-not-allowed"
        {...rest}
      />
      {/* Checkmark — drawn via SVG, shown when input is checked */}
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none -ml-[18px] mt-0.5 h-3.5 w-3.5 opacity-0 peer-checked:opacity-100"
      >
        <path
          d="M3.5 8L7 11.5L12.5 5.5"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span className="ml-1.5 flex-1">
        {label !== undefined && <span className="text-xs text-fg">{label}</span>}
        {description !== undefined && (
          <span className="mt-0.5 block text-[10px] text-fg-muted">{description}</span>
        )}
      </span>
    </label>
  );
});
