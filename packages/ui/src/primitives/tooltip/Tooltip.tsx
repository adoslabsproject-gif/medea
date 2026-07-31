import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, MouseEvent, ReactElement, RefCallback } from 'react';
import { createPortal } from 'react-dom';

import styles from './Tooltip.module.css';
import type { TooltipPlacement, TooltipProps } from './Tooltip.types';

type AnchorChild = ReactElement<{
  ref?: RefCallback<HTMLElement>;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
}>;

function computePosition(rect: DOMRect, placement: TooltipPlacement): CSSProperties {
  const gap = 8;
  switch (placement) {
    case 'top':
      return {
        top: `${(rect.top - gap).toString()}px`,
        left: `${(rect.left + rect.width / 2).toString()}px`,
        transform: 'translate(-50%, -100%)',
      };
    case 'bottom':
      return {
        top: `${(rect.bottom + gap).toString()}px`,
        left: `${(rect.left + rect.width / 2).toString()}px`,
        transform: 'translate(-50%, 0)',
      };
    case 'left':
      return {
        top: `${(rect.top + rect.height / 2).toString()}px`,
        left: `${(rect.left - gap).toString()}px`,
        transform: 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top: `${(rect.top + rect.height / 2).toString()}px`,
        left: `${(rect.right + gap).toString()}px`,
        transform: 'translate(0, -50%)',
      };
  }
}

export function Tooltip({
  children,
  label,
  placement = 'top',
  delay = 250,
  id: idProp,
}: TooltipProps) {
  const reactId = useId();
  const id = idProp ?? `${reactId}-tooltip`;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshPosition = useCallback(() => {
    if (!anchorRef.current) return;
    setPos(computePosition(anchorRef.current.getBoundingClientRect(), placement));
  }, [placement]);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      refreshPosition();
      setOpen(true);
    }, delay);
  }, [delay, refreshPosition]);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const handler = () => {
      refreshPosition();
    };
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [open, refreshPosition]);

  const child = children as AnchorChild;
  const childProps = child.props;
  const enhanced = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
    },
    onFocus: (e) => {
      childProps.onFocus?.(e);
      show();
    },
    onBlur: (e) => {
      childProps.onBlur?.(e);
      hide();
    },
    onMouseEnter: (e) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    'aria-describedby': [childProps['aria-describedby'], id].filter(Boolean).join(' '),
  });

  return (
    <>
      {enhanced}
      {typeof document !== 'undefined'
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              className={styles.bubble}
              data-state={open ? 'open' : 'closed'}
              style={pos}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
