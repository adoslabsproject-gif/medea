import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Size } from '../tokens.js';

const SIZE_INPUT: Record<Size, string> = {
  xs: 'h-6 text-[10px] px-1.5',
  sm: 'h-7 text-xs px-2',
  md: 'h-9 text-sm px-2.5',
  lg: 'h-11 text-base px-3',
};

interface CommonProps {
  /** Label rendered above the field. */
  label?: ReactNode;
  /** Helper text below the field. */
  help?: ReactNode;
  /** Validation error — renders the field with a danger ring + message. */
  error?: string;
  /** Leading content inside the field (icon or "https://"). */
  leftAddon?: ReactNode;
  /** Trailing content inside the field. */
  rightAddon?: ReactNode;
  /** Size of the input. Defaults to `sm`. */
  inputSize?: Size;
}

export type InputProps = CommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>;

/**
 * Input — labelled text field with optional left/right addons, helper,
 * and error state. All styles come from semantic tokens.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, help, error, leftAddon, rightAddon, inputSize = 'sm', className, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name ?? `input-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className="w-full">
      {label !== undefined && (
        <label htmlFor={inputId} className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-fg-muted">
          {label}
        </label>
      )}
      <div
        className={clsx(
          'flex w-full items-center overflow-hidden rounded-md border bg-surface-raised transition focus-within:border-accent',
          error ? 'border-danger/60' : 'border-line-strong hover:border-line-strong',
        )}
      >
        {leftAddon !== undefined && (
          <span className="border-r border-line bg-surface-subtle px-2 py-1 text-xs text-fg-muted">{leftAddon}</span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={clsx(
            'flex-1 bg-transparent text-fg outline-none placeholder-fg-subtle',
            SIZE_INPUT[inputSize],
            className,
          )}
          {...rest}
        />
        {rightAddon !== undefined && (
          <span className="border-l border-line bg-surface-subtle px-2 py-1 text-xs text-fg-muted">{rightAddon}</span>
        )}
      </div>
      {error !== undefined ? (
        <p className="mt-1 text-[10px] text-danger-soft">{error}</p>
      ) : help !== undefined ? (
        <p className="mt-1 text-[10px] text-fg-subtle">{help}</p>
      ) : null}
    </div>
  );
});

export type TextareaProps = CommonProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>;

/** Textarea — same API as Input but multi-line. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, help, error, inputSize = 'sm', className, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name ?? `ta-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className="w-full">
      {label !== undefined && (
        <label htmlFor={inputId} className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-fg-muted">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        className={clsx(
          'w-full rounded-md border bg-surface-raised text-fg outline-none placeholder-fg-subtle transition focus:border-accent',
          inputSize === 'lg' ? 'px-3 py-2 text-base' : inputSize === 'md' ? 'px-2.5 py-1.5 text-sm' : 'px-2 py-1 text-xs',
          error ? 'border-danger/60' : 'border-line-strong',
          className,
        )}
        {...rest}
      />
      {error !== undefined ? (
        <p className="mt-1 text-[10px] text-danger-soft">{error}</p>
      ) : help !== undefined ? (
        <p className="mt-1 text-[10px] text-fg-subtle">{help}</p>
      ) : null}
    </div>
  );
});
