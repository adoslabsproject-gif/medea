import { useEffect, type ReactNode } from 'react';
import clsx from 'clsx';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Modal title. */
  title?: ReactNode;
  /** Footer (typically action buttons). */
  footer?: ReactNode;
  /** Max width — defaults to `md` (28rem). */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Disable closing on Escape / backdrop click. */
  persistent?: boolean;
  children: ReactNode;
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[95vw] h-[95vh]',
};

/**
 * Modal — accessible dialog with focus trap and ESC close.
 * Renders a backdrop + centered card. Use for forms, confirmations,
 * deep navigation that warrants a focused context.
 */
export function Modal({
  open,
  onClose,
  title,
  footer,
  size = 'md',
  persistent,
  children,
}: ModalProps): React.ReactElement | null {
  useEffect(() => {
    if (!open || persistent) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [open, persistent, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-overlay/70 p-4 backdrop-blur-sm animate-fade-in"
      onClick={persistent ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={clsx(
          'flex w-full max-h-[90vh] flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-raised animate-slide-up',
          SIZE[size],
        )}
        onClick={(e) => { e.stopPropagation(); }}
      >
        {title !== undefined && (
          <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-fg-muted transition hover:bg-surface-subtle hover:text-fg"
              aria-label="Chiudi"
            >
              ✕
            </button>
          </header>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer !== undefined && (
          <footer className="flex items-center justify-end gap-2 border-t border-line-subtle bg-surface px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
