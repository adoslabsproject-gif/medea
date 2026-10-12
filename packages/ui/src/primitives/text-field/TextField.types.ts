import type { InputHTMLAttributes, ReactNode } from 'react';

export type TextFieldSize = 'sm' | 'md' | 'lg';
export type TextFieldStatus = 'default' | 'error' | 'success';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'prefix'
> {
  label?: string;
  hint?: string;
  errorMessage?: string;
  size?: TextFieldSize;
  status?: TextFieldStatus;
  startSlot?: ReactNode;
  endSlot?: ReactNode;
  fullWidth?: boolean;
  /**
   * Solo per `type="password"`: aggiunge il pulsante per guardare quello che
   * si è scritto.
   *
   * Non ci si affida all'«occhio» che Windows aggiunge da solo: compare solo
   * finché il campo non è mai stato toccato da codice, e in un campo
   * controllato sparisce al primo carattere.
   */
  revealable?: boolean;
}
