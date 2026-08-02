import { type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import type { AlertVariant } from '../tokens.js';

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: AlertVariant;
  title?: ReactNode;
  /** Optional close handler — adds a dismiss button. */
  onDismiss?: () => void;
  /** Custom leading icon. Defaults to a variant-appropriate one. */
  icon?: ReactNode;
}

const VARIANT: Record<AlertVariant, string> = {
  accent: 'border-accent/30 bg-accent/10 text-accent-soft',
  success: 'border-success/30 bg-success/10 text-success-soft',
  danger: 'border-danger/30 bg-danger/10 text-danger-soft',
  warning: 'border-warning/30 bg-warning/10 text-warning-soft',
  info: 'border-info/30 bg-info/10 text-info-soft',
};

const TITLE_TONE: Record<AlertVariant, string> = {
  accent: 'text-accent',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

const DEFAULT_ICONS: Record<AlertVariant, ReactNode> = {
  accent: <DotsIcon />,
  success: <CheckIcon />,
  danger: <AlertIcon />,
  warning: <AlertIcon />,
  info: <InfoIcon />,
};

/**
 * Alert — inline notification banner. Use for errors, warnings, hints
 * inside a page (NOT for transient toasts — that's the Toast component).
 */
export function Alert({
  variant = 'info',
  title,
  icon = DEFAULT_ICONS[variant],
  onDismiss,
  className,
  children,
  ...rest
}: AlertProps): React.ReactElement {
  return (
    <div
      role="alert"
      className={clsx(
        'flex gap-2.5 rounded-md border px-3 py-2.5 text-xs',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      <span className={clsx('mt-0.5 flex-shrink-0', TITLE_TONE[variant])} aria-hidden>
        {icon}
      </span>
      <div className="flex-1 leading-relaxed">
        {title !== undefined && (
          <p className={clsx('mb-0.5 font-semibold', TITLE_TONE[variant])}>{title}</p>
        )}
        {children}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 text-fg-muted hover:text-fg"
          aria-label="Chiudi"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function AlertIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function InfoIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
function DotsIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
    </svg>
  );
}
