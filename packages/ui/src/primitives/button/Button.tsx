import { forwardRef } from 'react';

import styles from './Button.module.css';
import type { ButtonProps } from './Button.types';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'solid',
    size = 'md',
    isLoading = false,
    isDisabled = false,
    fullWidth = false,
    startSlot,
    endSlot,
    children,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const disabled = isDisabled || isLoading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={isLoading || undefined}
      className={cx(
        styles.root,
        styles[size],
        styles[variant],
        fullWidth && styles.fullWidth,
        className,
      )}
      {...rest}
    >
      {isLoading ? <span className={styles.spinner} aria-hidden /> : startSlot}
      {children}
      {!isLoading && endSlot}
    </button>
  );
});
