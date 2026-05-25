import type { ReactElement } from 'react';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /**
   * Elemento ancora. DEVE essere un elemento focusabile/hoverabile (button, a, ecc.).
   * Riceverà aria-describedby + onFocus/Blur/Mouse handlers via cloneElement.
   */
  children: ReactElement;
  label: string;
  placement?: TooltipPlacement;
  /** Delay in ms prima dell'apertura (default 250). */
  delay?: number;
  id?: string;
}
