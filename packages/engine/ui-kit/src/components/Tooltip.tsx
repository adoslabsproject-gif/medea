import { useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

export interface TooltipProps {
  content: ReactNode;
  /** Tooltip placement relative to the trigger. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Delay before showing (ms). */
  delay?: number;
  /** Disable the tooltip altogether (passes children through). */
  disabled?: boolean;
  children: ReactNode;
}

const PLACEMENT: Record<NonNullable<TooltipProps['placement']>, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

/**
 * Tooltip — pure-CSS, no external lib. Show on hover/focus.
 * For complex popovers (rich content, click triggers), use Dropdown.
 */
export function Tooltip({
  content,
  placement = 'top',
  delay = 300,
  disabled,
  children,
}: TooltipProps): React.ReactElement {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (disabled) return <>{children}</>;

  const open = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setShow(true);
    }, delay);
  };
  const close = (): void => {
    if (timer.current) clearTimeout(timer.current);
    setShow(false);
  };

  return (
    <span
      className="relative inline-block"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          className={clsx(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-line-strong bg-surface-overlay px-2 py-1 text-[10px] text-fg shadow-raised animate-fade-in',
            PLACEMENT[placement],
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
