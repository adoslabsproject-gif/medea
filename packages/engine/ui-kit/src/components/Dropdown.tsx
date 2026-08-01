import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

export interface DropdownItem {
  /** Stable identifier — used as key. */
  id: string;
  label: ReactNode;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Optional trailing hint (e.g. keyboard shortcut). */
  hint?: ReactNode;
  /** When true, item is rendered disabled and not clickable. */
  disabled?: boolean;
  /** Visual style — defaults to default; `danger` colors the item red. */
  variant?: 'default' | 'danger';
  /** Click handler — closes the dropdown after. */
  onSelect?: () => void;
}

export interface DropdownProps {
  /** Trigger element — clicked to open/close the menu. */
  trigger: ReactNode;
  items: (DropdownItem | 'separator')[];
  /** Placement of the menu relative to the trigger. */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /** Optional menu className for width / max-height tweaks. */
  className?: string;
}

const PLACEMENT: Record<NonNullable<DropdownProps['placement']>, string> = {
  'bottom-start': 'top-full left-0 mt-1',
  'bottom-end': 'top-full right-0 mt-1',
  'top-start': 'bottom-full left-0 mb-1',
  'top-end': 'bottom-full right-0 mb-1',
};

/**
 * Dropdown — click-trigger popover menu with keyboard a11y, outside-click
 * close, and Escape close.
 *
 * Items can be DropdownItem objects or the literal string 'separator' to
 * render a horizontal divider.
 */
export function Dropdown({
  trigger,
  items,
  placement = 'bottom-start',
  className,
}: DropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSelect = (item: DropdownItem): void => {
    if (item.disabled) return;
    item.onSelect?.();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => { setOpen((v) => !v); }} className="contents">
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={clsx(
            'absolute z-50 min-w-[10rem] overflow-hidden rounded-md border border-line-strong bg-surface-overlay shadow-raised animate-slide-up',
            PLACEMENT[placement],
            className,
          )}
        >
          {items.map((it, idx) => {
            if (it === 'separator') {
              return <div key={`sep-${idx.toString()}`} className="my-1 border-t border-line-subtle" />;
            }
            const isDanger = it.variant === 'danger';
            return (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => { handleSelect(it); }}
                className={clsx(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition',
                  isDanger
                    ? 'text-danger-soft hover:bg-danger/10 hover:text-danger'
                    : 'text-fg hover:bg-surface-subtle',
                  it.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                )}
              >
                {it.icon !== undefined && <span aria-hidden className="flex-shrink-0">{it.icon}</span>}
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint !== undefined && <span className="text-[10px] text-fg-subtle">{it.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
