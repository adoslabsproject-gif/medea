import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Title rendered in the header section. */
  title?: ReactNode;
  /** Subtitle / description below the title. */
  description?: ReactNode;
  /** Right-side header actions (buttons, badges). */
  actions?: ReactNode;
  /** Adds the `shadow-raised` shadow for emphasis. */
  elevated?: boolean;
  /** Removes the default body padding (useful when content has its own). */
  noPadding?: boolean;
}

/**
 * Card — the canonical surface container. Use for any "panel" or "box"
 * in the UI: sections in Settings, items in a list, modals, drawers.
 *
 * Composition:
 *   <Card title="Account email" actions={<Button>Save</Button>}>
 *     <Input … />
 *   </Card>
 *
 * For headerless cards, omit `title`/`actions` and put content directly:
 *   <Card><CustomContent /></Card>
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, description, actions, elevated, noPadding, className, children, ...rest },
  ref,
) {
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined;
  return (
    <div
      ref={ref}
      className={clsx(
        'overflow-hidden rounded-lg border border-line bg-surface-raised',
        elevated ? 'shadow-raised' : 'shadow-soft',
        className,
      )}
      {...rest}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-3 border-b border-line-subtle px-4 py-3">
          <div className="min-w-0 flex-1">
            {title !== undefined && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {description !== undefined && (
              <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="flex flex-shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={clsx(!noPadding && 'p-4')}>{children}</div>
    </div>
  );
});
