import type { ReactNode } from 'react';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** Se false, click sul backdrop non chiude. Default true. */
  closeOnBackdropClick?: boolean;
  /** Se false, Escape non chiude. Default true. */
  closeOnEscape?: boolean;
  'aria-labelledby'?: string;
}
