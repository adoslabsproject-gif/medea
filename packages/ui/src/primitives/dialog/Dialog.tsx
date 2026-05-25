import { useCallback, useEffect, useId, useRef } from 'react';
import type { MouseEvent, SyntheticEvent } from 'react';

import styles from './Dialog.module.css';
import type { DialogProps } from './Dialog.types';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnBackdropClick = true,
  closeOnEscape = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descId = description ? `${reactId}-desc` : undefined;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      document.body.style.overflow = 'hidden';
    } else if (!open && el.open) {
      el.close();
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const handleCancel = useCallback(
    (e: SyntheticEvent<HTMLDialogElement>) => {
      if (!closeOnEscape) {
        e.preventDefault();
        return;
      }
      onClose();
    },
    [closeOnEscape, onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDialogElement>) => {
      if (!closeOnBackdropClick) return;
      const dialog = ref.current;
      if (!dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) onClose();
    },
    [closeOnBackdropClick, onClose],
  );

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, styles[size])}
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={handleCancel}
      onClick={handleBackdropClick}
    >
      <div className={styles.surface}>
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description && (
              <p id={descId} className={styles.description}>
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Chiudi"
            className={styles.closeBtn}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </dialog>
  );
}
