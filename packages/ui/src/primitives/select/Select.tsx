import { forwardRef, useId } from 'react';

import styles from './Select.module.css';
import type { SelectItem, SelectOption, SelectProps } from './Select.types';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

function isGroup(item: SelectItem): item is { label: string; options: SelectOption[] } {
  return Array.isArray((item as { options?: unknown }).options);
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hint,
    errorMessage,
    size = 'md',
    items,
    placeholder,
    startSlot,
    fullWidth = false,
    id: idProp,
    className,
    'aria-describedby': describedByProp,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp ?? `${reactId}-select`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = errorMessage ? `${id}-error` : undefined;
  const describedBy = [describedByProp, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cx(styles.root, fullWidth && styles.fullWidth, className)}>
      {label && (
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
      )}
      <div className={cx(styles.control, styles[size])}>
        {startSlot && (
          <span className={styles.slot} aria-hidden>
            {startSlot}
          </span>
        )}
        <select
          {...rest}
          ref={ref}
          id={id}
          className={styles.select}
          aria-invalid={errorMessage ? true : undefined}
          aria-describedby={describedBy}
        >
          {placeholder && (
            <option value="" disabled hidden>
              {placeholder}
            </option>
          )}
          {items.map((item, i) =>
            isGroup(item) ? (
              <optgroup key={`g-${i.toString()}`} label={item.label}>
                {item.options.map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              <option key={item.value} value={item.value} disabled={item.disabled}>
                {item.label}
              </option>
            ),
          )}
        </select>
        <span className={styles.caret} aria-hidden>
          ▾
        </span>
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
