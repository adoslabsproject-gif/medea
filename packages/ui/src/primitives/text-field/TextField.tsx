import { forwardRef, useId } from 'react';

import styles from './TextField.module.css';
import type { TextFieldProps } from './TextField.types';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    hint,
    errorMessage,
    size = 'md',
    status: statusProp,
    startSlot,
    endSlot,
    fullWidth = false,
    id: idProp,
    className,
    'aria-describedby': describedByProp,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp ?? `${reactId}-input`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = errorMessage ? `${id}-error` : undefined;
  const status = errorMessage ? 'error' : (statusProp ?? 'default');

  const describedBy = [describedByProp, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cx(styles.root, fullWidth && styles.fullWidth, className)}>
      {label && (
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
      )}
      <div className={cx(styles.control, styles[size], status !== 'default' && styles[status])}>
        {startSlot && (
          <span className={styles.slot} aria-hidden>
            {startSlot}
          </span>
        )}
        <input
          {...rest}
          ref={ref}
          id={id}
          className={styles.input}
          aria-invalid={status === 'error' || undefined}
          aria-describedby={describedBy}
        />
        {endSlot && (
          <span className={styles.slot} aria-hidden>
            {endSlot}
          </span>
        )}
      </div>
      {errorMessage ? (
        <span id={errorId} role="alert" className={styles.errorMessage}>
          {errorMessage}
        </span>
      ) : hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});
